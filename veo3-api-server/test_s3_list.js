const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, './.env') });

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function test() {
  const command = new ListObjectsV2Command({
    Bucket: process.env.R2_BUCKET_NAME,
    Prefix: "videos/",
    MaxKeys: 10
  });

  try {
    let isTruncated = true;
    let contents = [];
    let commandRes = await s3Client.send(command);
    console.log("Files in bucket 'videos/':");
    commandRes.Contents?.forEach((c) => console.log(` - ${c.Key} (${c.Size} bytes)`));
  } catch (err) {
    console.error(err);
  }
}
test();
