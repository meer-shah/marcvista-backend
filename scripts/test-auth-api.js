const API_BASE_URL = 'http://localhost:4000';

async function testAuthAPI() {
  console.log('Testing Auth API...\n');

  try {
    // Test 1: Register a test user
    console.log('[TEST 1] Registering test user...');
    const registerRes = await fetch(`${API_BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `test${Date.now()}@example.com`,
        password: 'test123456',
        name: 'Test User'
      })
    });
    const registerData = await registerRes.json();

    if (registerRes.ok) {
      console.log('✓ Registration successful');
      console.log('  Token:', registerData.token.substring(0, 30) + '...');
      const token = registerData.token;

      // Test 2: Get current user with token
      console.log('\n[TEST 2] Getting current user...');
      const meRes = await fetch(`${API_BASE_URL}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const meData = await meRes.json();

      if (meRes.ok) {
        console.log('✓ Authenticated successfully as:', meData.user.email);
      } else {
        console.log('✗ Failed to get user:', meData);
      }

      // Test 3: Access protected endpoint (risk profiles)
      console.log('\n[TEST 3] Accessing protected endpoint (risk profiles)...');
      const profilesRes = await fetch(`${API_BASE_URL}/api/riskprofiles`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const profilesData = await profilesRes.json();

      if (profilesRes.ok) {
        console.log('✓ Risk profiles accessible:', Array.isArray(profilesData) ? `${profilesData.length} profiles` : profilesData);
      } else {
        console.log('✗ Failed to get profiles:', profilesData);
      }

      // Test 4: Logout
      console.log('\n[TEST 4] Logging out...');
      const logoutRes = await fetch(`${API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (logoutRes.ok) {
        console.log('✓ Logout successful');
      } else {
        console.log('✗ Logout failed');
      }

    } else {
      console.log('✗ Registration failed:', registerData);
    }

  } catch (error) {
    console.error('✗ Error during tests:', error.message);
  }

  console.log('\n========================================');
  console.log('Auth API test complete');
  console.log('========================================\n');
}

testAuthAPI();
