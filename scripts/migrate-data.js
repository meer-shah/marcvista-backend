const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const RiskProfile = require('../models/riskprofilemodal');
const ApiConnection = require('../models/ApiConnection');

const MONGODB_URI = 'mongodb://localhost:27017/markvista';

async function migrate() {
  try {
    console.log('Starting data migration...\n');

    // Connect to MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Check if users already exist
    const existingUsers = await User.countDocuments();
    if (existingUsers > 0) {
      console.log(`⚠️  Found ${existingUsers} existing users. Skipping migration.`);
      console.log('   Data is already migrated. Use one of these accounts:');
      const users = await User.find().select('email name');
      users.forEach(u => console.log(`   - ${u.email}`));
      await mongoose.disconnect();
      process.exit(0);
    }

    // Step 1: Create system user (default admin)
    const defaultPassword = 'admin123';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    const systemUser = new User({
      email: 'admin@markvista.local',
      password: hashedPassword,
      name: 'System Admin'
    });
    await systemUser.save();
    console.log('✅ Created system user:');
    console.log(`   Email: ${systemUser.email}`);
    console.log(`   Password: ${defaultPassword}`);
    console.log(`   User ID: ${systemUser._id}\n`);

    // Step 2: Migrate existing RiskProfiles
    const profiles = await RiskProfile.find({});
    console.log(`Found ${profiles.length} risk profiles`);

    for (const profile of profiles) {
      profile.user = systemUser._id;
      await profile.save();
    }
    console.log(`✅ Assigned ${profiles.length} risk profiles to system user\n`);

    // Step 3: Migrate existing ApiConnection (if any)
    const connections = await ApiConnection.find({});
    console.log(`Found ${connections.length} API connections`);

    for (const conn of connections) {
      conn.user = systemUser._id;
      await conn.save();
    }
    console.log(`✅ Assigned ${connections.length} API connections to system user\n`);

    console.log('✅ Migration completed successfully!');
    console.log('\n📋 New credentials:');
    console.log(`   Email: ${systemUser.email}`);
    console.log(`   Password: ${defaultPassword}`);
    console.log('\n⚠️  IMPORTANT: Change the password after first login!');

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
