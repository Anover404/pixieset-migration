// Simple test script for backend API
const BACKEND_BASE_URL = "https://pixie-set-backend-145714886649.us-central1.run.app";
const AUTH_TOKEN = "test-migration-token";

// Dummy test data
const testData = {
  albumName: "Test Collection",
  fullMetadata: {
    id: 12345,
    name: "Test Collection",
    photo_count: 100
  },
  domain: "test-user"
};

async function testBackendAPI() {
  console.log("Testing backend API...");
  console.log("URL:", `${BACKEND_BASE_URL}/api/create-pixieset-album`);
  console.log("Payload:", JSON.stringify(testData, null, 2));
  console.log("\n");

  try {
    const response = await fetch(`${BACKEND_BASE_URL}/api/create-pixieset-album`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        authorization: AUTH_TOKEN
      },
      body: JSON.stringify(testData)
    });

    console.log("Response Status:", response.status, response.statusText);
    console.log("Response Headers:", Object.fromEntries(response.headers.entries()));

    const responseText = await response.text();
    console.log("Response Body:", responseText);

    let responseData;
    try {
      responseData = JSON.parse(responseText);
      console.log("Parsed Response:", JSON.stringify(responseData, null, 2));
    } catch (e) {
      console.log("Response is not JSON");
    }

    if (!response.ok) {
      console.error("❌ API call failed");
      return;
    }

    console.log("✅ API call successful!");
  } catch (error) {
    console.error("❌ Error calling API:", error.message);
    console.error(error);
  }
}

testBackendAPI();
