const profile = require('./profile')
const auth = require('./auth')

module.exports = {
  IProfileDB: profile.IProfileDB,
  IAuthDB: auth.IAuthDB,
  profileDB: {
    addDatabaseOptions: profile.addDatabaseOptions,
    initializeDatabase: profile.initializeDatabase
  },
  authDB: {
    addDatabaseOptions: auth.addDatabaseOptions,
    initializeDatabase: auth.initializeDatabase
  }
}
