const NodeWebcam = require( "node-webcam" );
const {BlobServiceClient} = require('@azure/storage-blob');
const config = require("./config.json");

let blobServiceClient = null;
let containerClient = null;

let logfn = console.log
console.log = function(){
  let args = Array.from(arguments);
  let datePf = "" + new Date().toISOString() + ": ";
  if(typeof args[0] == "string") {
    args[0] = datePf + args[0];
  }
  else {
    args.unshift("" + new Date().toISOString() + ": ");
  }
  logfn(...args);
}

/**
 *
 */
async function initBlobClient() {
  let connStr = config.storageConnectionString;
  if(!connStr || connStr.length == 0) throw "No connection string in config!";
  blobServiceClient = BlobServiceClient.fromConnectionString(config.storageConnectionString);
  containerClient = blobServiceClient.getContainerClient(config.containerName);
}

function zeroPad(number, digits) {
  let res = ""+number;
  while(res.length < digits) {
    res = "0" + res;
  }
  return res;
}


var opts = {
    //Picture related
    width: 1280,
    height: 720,
    quality: 100,

    // Number of frames to capture
    // More the frames, longer it takes to capture
    // Use higher framerate for quality. Ex: 60
    frames: 1,

    //Delay in seconds to take shot
    //if the platform supports miliseconds
    //use a float (0.1)
    //Currently only on windows
    delay: 0,

    //Save shots in memory
    saveShots: true,

    // [jpeg, png] support varies
    // Webcam.OutputTypes
    output: "jpeg",

    //Which camera to use
    //Use Webcam.list() for results
    //false for default device
    device: false,

    // [location, buffer, base64]
    // Webcam.CallbackReturnTypes
    callbackReturn: "buffer",

    //Logging
    verbose: false
};

let webcam = NodeWebcam.create( opts );
let lastUpload = null;

async function uploadImage(blobName, data) {
  console.log("\nUploading to Azure storage as blob:\n\t", blobName);
  let blockBlobClient = containerClient.getBlockBlobClient(blobName);
  // Upload data to the blob
  let uploadBlobResponse = null;
  try {
    uploadBlobResponse = await blockBlobClient.upload(data, data.length);
    console.log(
      "Blob was uploaded successfully. requestId: ",
      uploadBlobResponse.requestId
    );
    lastUpload = new Date();
  }
  catch(e) {
    console.error("uploadFailed: ", e);
  }
}

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

async function run() {
  
  console.log("connecting to blob...");
  await initBlobClient();
  
  while(true) {
    let now = new Date();
    //if( (now.getHours() > 6 && now.getHours() < 22)  || (lastUpload && (now.getTime() - lastUpload.getTime()) < 59*60*1000))) {
    console.log("checking condition, lastUpload = " + lastUpload);
    if( (now.getHours() < 13 || now.getHours() > 15)  || 
        (lastUpload && (now.getTime() - lastUpload.getTime()) < 59*60*1000)
       ) {      
      console.log("no new img required, going to sleep");
      await sleep(5*60*1000);
      continue;
    }
    console.log("capturing new img...");
    webcam.capture("./testImg.jpeg", (err, data) => {
      if(err) {
        console.error("failed to capture");
      }
      else {
        console.log("data received, type " + typeof data + ", len " + data.length);
        // Get a block blob client
        let d = new Date();
        
        let blobName = "" + d.getUTCFullYear() + "/" + zeroPad(d.getUTCMonth()+1,2) + "/" + zeroPad(d.getUTCDate(),2) + "/" + zeroPad(d.getUTCHours(),2) + "_srvl_" +new Date().toISOString() + ".jpeg";
        
        uploadImage(blobName, data);
      }
    });
  }
}

run();