const {BlobServiceClient} = require('@azure/storage-blob');

let blobServiceClient;
let containerClient;

async function initBlobClient() {
  let connStr = process.env["CONN_STRING"];
  if(!connStr || connStr.length == 0) {
    console.error("No connection string found in ENV CONN_STRING");
    process.exit(1);
  }
  let containerName = process.env["CONTAINER_NAME"];
  if(!containerName || containerName.length == 0) {
    console.error("No container name found in ENV CONTAINER_NAME");
    process.exit(1);
  }
  blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
  containerClient = blobServiceClient.getContainerClient(containerName);
}


async function test() {

  await initBlobClient();

  let fn = "2021/01/01/12.csv"

  // prepare the block with multiple appends
  let appendBlobClient = containerClient.getAppendBlobClient(fn);

  await appendBlobClient.createIfNotExists();

  let data = "some\tcsv\tdata\tline\tcontent\tfor\tillustration\tpurpose";
  for(let i = 0; i < 10;i++) {
    try {
      await appendBlobClient.appendBlock(data+"\t"+i+"\r\n", data.length+4);
    }	  
    catch(e){
      console.error("block append failed, test precondition invalid: ", e);
      process.exit(1);
    }
  }

  try {
    await appendBlobClient.seal();
  }
  catch(e) {
    console.error("appendBlob.seal failed: ", e);
  }

}

test();

