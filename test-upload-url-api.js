// Simple test script for get upload URL API
const BACKEND_BASE_URL = "https://pixie-set-backend-145714886649.us-central1.run.app";
const AUTH_TOKEN = "test-migration-token";

// Dummy test data
const testData = {
  filename: "test-photo.jpg",
  albumName: "Test Collection",
  domain: "test-user"
};

async function testUploadUrlAPI() {
  console.log("Testing get upload URL API...");
  console.log("URL:", `${BACKEND_BASE_URL}/api/get-pixieset-upload-url`);
  console.log("Payload:", JSON.stringify(testData, null, 2));
  console.log("\n");

  try {
    const response = await fetch(`${BACKEND_BASE_URL}/api/get-pixieset-upload-url`, {
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
      
      if (responseData.ok && responseData.uploadUrl) {
        console.log("\n✅ Upload URL received successfully!");
        console.log("Upload URL:", responseData.uploadUrl.substring(0, 100) + "...");
        console.log("Object Path:", responseData.objectPath);
      } else if (responseData.skipped) {
        console.log("\n✅ File already exists (skipped)");
        console.log("Object Path:", responseData.objectPath);
      } else {
        console.log("\n❌ API call failed");
      }
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

testUploadUrlAPI();
