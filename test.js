const fs = require('fs');
const {BlobServiceClient} = require('@azure/storage-blob');
const config = require('./config.json');

let blobServiceClient;
let containerClient;

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

async function initBlobClient() {
  let connStr = config.storageConnectionString;
  if(!connStr || connStr.length == 0) throw "No connection string in config!";
  blobServiceClient = BlobServiceClient.fromConnectionString(config.storageConnectionString);
  containerClient = blobServiceClient.getContainerClient(config.containerName);
}


async function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on("error", reject);
  });
}

async function test() {

  await initBlobClient();

  let fn = "2022/02/21/17.csv"

  await seal(fn);

  await download(fn);
}

async function seal(fn) {
  let blobClient = await containerClient.getAppendBlobClient(fn);
  console.log("sealing " + fn);
  let startTime = new Date();
  try {
    await blobClient.seal();
    let endTime = new Date();
    console.log("sealed, duration " + (endTime.getTime()-startTime.getTime())/1000 + " s");
  }
  catch(e) {
    console.log("seal failed: ", e);
  }
}

async function download(fn) {
  let blobClient = await containerClient.getBlobClient(fn);
  console.log("starting to download " + fn);
  let startTime = new Date();
  let res = await blobClient.download();
  let data = await streamToBuffer(res.readableStreamBody);
  let endTime = new Date();
  console.log("blob downloaded, " + data.length + " bytes, duration " + (endTime.getTime()-startTime.getTime())/1000 + " s");
}

test();

//serialAMA.write("data from AMA serial\n");



