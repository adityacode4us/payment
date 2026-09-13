const { Client } = require('pg');

async function setup() {
  // Connect as postgres superuser
  const admin = new Client({
    connectionString: 'postgres://postgres:postgres@localhost:5432/postgres'
  });
  await admin.connect();
  console.log('Connected to PostgreSQL as postgres');

  // Create database if not exists
  const dbCheck = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'wallet'");
  if (dbCheck.rows.length === 0) {
    await admin.query('CREATE DATABASE wallet');
    console.log('Created database: wallet');
  } else {
    console.log('Database "wallet" already exists');
  }

  // Create user if not exists
  const userCheck = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'wallet'");
  if (userCheck.rows.length === 0) {
    await admin.query("CREATE USER wallet WITH PASSWORD 'wallet'");
    console.log('Created user: wallet');
  } else {
    console.log('User "wallet" already exists');
  }

  // Grant privileges
  await admin.query('GRANT ALL PRIVILEGES ON DATABASE wallet TO wallet');
  console.log('Granted DB privileges');
  await admin.end();

  // Connect to wallet DB to grant schema privileges
  const walletAdmin = new Client({
    connectionString: 'postgres://postgres:postgres@localhost:5432/wallet'
  });
  await walletAdmin.connect();
  await walletAdmin.query('GRANT ALL ON SCHEMA public TO wallet');
  console.log('Granted schema privileges');
  await walletAdmin.end();

  console.log('\n✅ Database setup complete!');
  console.log('Connection string: postgres://wallet:wallet@localhost:5432/wallet');
}

setup().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
