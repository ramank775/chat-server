const profile = require('./profile')

module.exports = {
  IProfileDB: profile.IProfileDB,
  profileDB: {
    addDatabaseOptions: profile.addDatabaseOptions,
    initializeDatabase: profile.initializeDatabase
  }
}
