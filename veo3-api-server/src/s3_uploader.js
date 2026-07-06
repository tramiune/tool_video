const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Upload a buffer to Cloudflare R2
 * @param {Buffer} buffer - File buffer
 * @param {string} fileName - Destination file name
 * @param {string} contentType - e.g. 'video/mp4' or 'image/jpeg'
 * @returns {Promise<string>} Public URL of the uploaded file
 */
async function uploadToR2(buffer, fileName, contentType) {
  const bucketName = process.env.R2_BUCKET_NAME;
  
  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: fileName,
    Body: buffer,
    ContentType: contentType,
  }));

  return `${process.env.R2_PUBLIC_BASE}/${fileName}`;
}

/**
 * Delete a file from Cloudflare R2
 * @param {string} fileName - File key in bucket
 */
async function deleteFromR2(fileName) {
  const bucketName = process.env.R2_BUCKET_NAME;
  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: fileName,
  }));
}

module.exports = { uploadToR2, deleteFromR2 };
