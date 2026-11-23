const { Option } = require('commander');
const { VerifyNowClient, RESPONSE } = require('@vendor/message-central');
const { ISmsSender, SmsGatewayError, SmsGatewayUnavailableError } = require('./sms-sender');
const { AuthError } = require('../auth-provider');

/**
 * Launch sender (decision 268): Message Central VerifyNow texts from its
 * approved sender (UTOMOB in India) with no DLT registration of ours. It makes
 * and checks the code, so the provider keeps its verificationId instead of a
 * hash; our sessions, SMS budgets, attempt limit and lockout still apply.
 */
class VerifyNowSmsSender extends ISmsSender {
  ownsCode = true;

  // ponytail: VerifyNow's send reply says `timeout: 60`, taken as its resend
  // window; read it from the reply if the first live test says otherwise.
  resendAfterSec = 60;

  #client;

  #countries;

  #log;

  constructor(context) {
    super();
    const {
      verifynowUrl, verifynowCustomerId, verifynowPassword, verifynowEmail, verifynowCountries
    } = context.options;
    if (!verifynowCustomerId || !verifynowPassword) {
      throw new Error('verifynow needs VERIFYNOW_CUSTOMER_ID and VERIFYNOW_PASSWORD');
    }
    // calling codes are prefix-free, so at most one matches a number
    this.#countries = verifynowCountries.split(',').map((c) => c.trim()).filter(Boolean);
    this.#log = context.log;
    this.#client = new VerifyNowClient({
      baseUrl: verifynowUrl,
      customerId: verifynowCustomerId,
      password: verifynowPassword,
      email: verifynowEmail
    });
  }

  /**
   * Text a new code.
   * @param {{phone: string}} args E.164
   * @returns {Promise<string>} the reference check() takes
   */
  async start({ phone }) {
    const digits = phone.slice(1);
    const countryCode = this.#countries.find((c) => digits.startsWith(c));
    if (!countryCode) {
      // VERIFYNOW_COUNTRIES keeps costly routes (and SMS pumping) out
      throw new SmsGatewayError('No SMS route to this country yet');
    }
    try {
      const { verificationId } = await this.#client.sendOtp({
        countryCode,
        mobileNumber: digits.slice(countryCode.length),
        otpLength: 6
      });
      return verificationId;
    } catch (error) {
      this.#log.error(`verifynow send failed: ${error.message}`);
      if (error.transient) throw new SmsGatewayUnavailableError('SMS gateway unreachable');
      throw new SmsGatewayError('SMS gateway refused the send');
    }
  }

  /**
   * @param {string} ref from start()
   * @param {string} code what the user typed
   * @returns {Promise<boolean>} false = wrong code (counts as an attempt)
   */
  async check(ref, code) {
    let result;
    try {
      result = await this.#client.validateOtp({ verificationId: ref, code });
    } catch (error) {
      this.#log.error(`verifynow validate failed: ${error.message}`);
      throw new AuthError(503, 'SMS_GATEWAY_UNAVAILABLE', 'Could not check the code, try again');
    }
    switch (result) {
      case RESPONSE.SUCCESS:
        return true;
      case RESPONSE.WRONG_OTP_PROVIDED:
      case RESPONSE.VERIFICATION_FAILED:
        return false;
      case RESPONSE.VERIFICATION_EXPIRED:
        throw new AuthError(410, 'CODE_EXPIRED', 'This code has expired, request a new one');
      case RESPONSE.ALREADY_VERIFIED:
        throw new AuthError(410, 'SESSION_CONSUMED', 'This session was already verified');
      case RESPONSE.MAXIMUM_LIMIT_REACHED:
        throw new AuthError(423, 'SESSION_LOCKED', 'Too many wrong codes, request a new code', {
          scope: 'session'
        });
      default:
        this.#log.error(`verifynow validate answered ${result}`);
        throw new AuthError(503, 'SMS_GATEWAY_UNAVAILABLE', 'Could not check the code, try again');
    }
  }
}

function addOptions(cmd) {
  return cmd
    .option('--verifynow-url <url>', 'VerifyNow API base url', 'https://cpaas.messagecentral.com')
    .addOption(new Option('--verifynow-customer-id <id>', 'Message Central customer id')
      .env('VERIFYNOW_CUSTOMER_ID'))
    .addOption(new Option('--verifynow-password <password>', 'Message Central account password')
      .env('VERIFYNOW_PASSWORD'))
    .addOption(new Option('--verifynow-email <email>', 'Message Central account email')
      .env('VERIFYNOW_EMAIL'))
    .addOption(new Option('--verifynow-countries <codes>', 'calling codes it texts, comma separated')
      .env('VERIFYNOW_COUNTRIES')
      .default('91'));
}

module.exports = {
  code: 'verifynow',
  addOptions,
  Implementation: VerifyNowSmsSender
};
