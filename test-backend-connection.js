/**
 * Test script to verify backend API connectivity
 * Run with: node test-backend-connection.js
 */

const BACKEND_BASE_URL = "https://pixie-set-backend-pxbb63zhgq-uc.a.run.app";
const AUTH_TOKEN = "test-migration-token";

async function testBackendAPI() {
  console.log("Testing backend API connection...\n");
  
  const endpoint = "/api/create-pixieset-album";
  const url = `${BACKEND_BASE_URL}${endpoint}`;
  
  const testPayload = {
    albumName: "test-album",
    fullMetadata: {
      id: 123,
      name: "Test Collection",
      photo_count: 10
    },
    domain: "test-user"
  };
  
  console.log("Request Details:");
  console.log(`  URL: ${url}`);
  console.log(`  Method: POST`);
  console.log(`  Headers: Content-Type, Accept, authorization`);
  console.log(`  Body:`, JSON.stringify(testPayload, null, 2));
  console.log("\n");
  
  try {
    console.log("Making request...");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "authorization": AUTH_TOKEN
      },
      body: JSON.stringify(testPayload)
    });
    
    console.log(`\nResponse Status: ${response.status} ${response.statusText}`);
    console.log("Response Headers:");
    response.headers.forEach((value, key) => {
      console.log(`  ${key}: ${value}`);
    });
    
    const responseText = await response.text();
    console.log("\nResponse Body:");
    try {
      const json = JSON.parse(responseText);
      console.log(JSON.stringify(json, null, 2));
    } catch {
      console.log(responseText);
    }
    
    if (response.ok) {
      console.log("\n✅ SUCCESS: Backend API is reachable and responding!");
    } else {
      console.log("\n⚠️  WARNING: Backend responded with error status");
    }
    
  } catch (error) {
    console.error("\n❌ ERROR: Failed to connect to backend");
    console.error(`Error Type: ${error.constructor.name}`);
    console.error(`Error Message: ${error.message}`);
    
    if (error.message.includes("Failed to fetch") || error.message.includes("NetworkError")) {
      console.error("\nPossible causes:");
      console.error("  1. Backend server is down or unreachable");
      console.error("  2. Network connectivity issue");
      console.error("  3. DNS resolution failure");
      console.error("  4. Firewall blocking the connection");
    }
    
    if (error.cause) {
      console.error(`\nError Cause: ${error.cause}`);
    }
  }
}

// Run the test
testBackendAPI();
