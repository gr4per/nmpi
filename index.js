const fs = require('fs');
const {SerialPort} = require('serialport')
const {ReadlineParser} = require('@serialport/parser-readline');
const {DelimiterParser} = require('@serialport/parser-delimiter')
const {BlobServiceClient} = require('@azure/storage-blob');

const serialUSB = new SerialPort({path:"/dev/ttyUSB0", baudRate: 9600});
const serialAMA = new SerialPort({path:"/dev/ttyAMA0", baudRate: 9600});
const config = require("./config.json");

let ID = 1;
let deviceState = 0;

let blobServiceClient;
let containerClient;

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
class MeasurementBuffer {
  constructor(size) {
    this.size = 3600;
    this.currentSize = 0;
    this.buf = new Array(this.size);
    this.idx = this.size-1; // pointing to top, i.e. last written record
    this.startIdx = this.idx;
    this.startTime = new Date(new Date().getTime()/1000*1000); // put on full second, this is the integration END time of the interval covered by the bin
    this.topTime = this.startTime; // again, this is the END time of the interval, i.e. bin 13:26:47 covers integration from 13:26:46-13:26:47
  }

  init() {
    for(let i = this.idx; i >= 0;i--) {
      this.set(i, [this.getTime(i),0, 0.0,0.0,0.0,0.0, 0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0]);
    }
  } 
  
  getIndex(time) {
    
    if(time > topTime){
      throw "Time " + time + " > MeasBuffer topTime " + this.topTime + ", no index!";
    }
    let timeD = this.topTime.getTime() - time.getTime();
    let binD = timeD/1000;
    if(binD > this.size) {
      console.log("time " + time + " is outside range of measurement buffer.");
      return -1;
    }
    let idx = this.idx - binD;
    if(idx < 0) idx = this.size +idx
    return idx;
  }

  getTime(idx) {
    if(idx > this.idx) idx = idx-this.size;
    return new Date(this.topTime.getTime()-(this.idx-idx)*1000);
  }

  getSPLEnergyEquivalent(spl) {
    return Math.pow(10,spl/10.0);
  }

  set(index, valueArr) {
    valueArr = valueArr.slice();
    let t = this.getTime(index);
    let rt = valueArr.shift();
    this.buf[index] = {time: t,respTime:rt,leq_s:{a:valueArr[1],b:valueArr[2],c:valueArr[3],z:valueArr[4],t6:valueArr[5],t8:valueArr[6],t10:valueArr[7],t12:valueArr[8],t16:valueArr[9],t20:valueArr[10],t25:valueArr[11],t31:valueArr[12],t40:valueArr[13],t50:valueArr[14],t63:valueArr[15],t80:valueArr[16],t100:valueArr[17],t125:valueArr[18],t160:valueArr[19],t200:valueArr[20],t250:valueArr[21],t315:valueArr[22],t400:valueArr[23],t500:valueArr[24],t630:valueArr[25],t800:valueArr[26],t1000:valueArr[27],t1250:valueArr[28],t1600:valueArr[29],t2000:valueArr[30],t2500:valueArr[31],t3150:valueArr[32],tk4:valueArr[33],tk5:valueArr[34],t6k:valueArr[35],t8k:valueArr[36],t10k:valueArr[37],t12k:valueArr[38],t16k:valueArr[39],t20k:valueArr[40]},ee:{}};
    //console.log("set, valueArr = " + JSON.stringify(valueArr)+ "\nlen = " + valueArr.length + "\nrecord so far:" + JSON.stringify(this.buf[index],null,2)+"\nleq_s keys: " + JSON.stringify(Object.keys(this.buf[index]["leq_s"])));
    for(let l of Object.keys(this.buf[index]["leq_s"])) {
      this.buf[index].ee[l] = this.getSPLEnergyEquivalent(this.buf[index]["leq_s"][l]);
    }
  }

  calculateWindowValues() {
    // define 5m window
    let dt = 5*60*1000;
    if(this.topTime.getTime() - this.startTime.getTime() < dt) {
      dt = (this.topTime.getTime()-this.startTime.getTime());
    }
    let idx = this.idx;
    let start5m = idx - dt/1000;
    if(start5m < 0) start5m = this.size+start5m;
    console.log("5m start idx = " + start5m + ", time = " + this.getTime(start5m));
    this.aggregateWindow(start5m, "leq_5m");

    // define 1h window
    let start1h = idx+1;
    if(start1h > this.size-1)start1h = start1h-this.size;
    console.log("1h start index is " + start1h + ", time = " + this.buf[start1h].time);
    this.aggregateWindow(start1h, "leq_1h");
  }

  aggregateWindow(startIdx, name) {	  
    let target = this.buf[this.idx];
    //console.log("aggregate " + name + ", target " + this.idx + ": " + JSON.stringify(target));
    target[name] = {};
    for(let l of Object.keys(target.ee))target[name][l]=0;
    let binCount = 0;
    let si = startIdx;
    if(si > this.idx)si-=this.size;
    for(let ni = si; ni < this.idx+1;ni++) {
      let i = ni;
      if(ni<0)i+=this.size; // ni can be negative and is counting up towards idx. i needs to be positive, so we map it to buf range
      //console.log("adding from " + i + " (ni=" + ni + "): ");// + JSON.stringify(this.buf[i],null,2));
      for(let l of Object.keys(target.ee)){
	//console.log("i=" + i + " adding value with label " + l + " to target from row " + JSON.stringify(this.buf[i])); 
	target[name][l] += this.buf[i]["ee"][l];
      }
      binCount++;
    }
    console.log("binCount = " + binCount);
    //now divide energy equivalent by bins (=s) to get power, then convert to SPL
    for(let l of Object.keys(target["ee"])) {
      target[name][l] /= binCount;
      target[name][l] = 10*Math.log10(target[name][l]);
    }
    console.log("aggregate window done");
  }

  push(valueArr) {
    if(this.currentSize == 0) { // on first push we set start time
      this.topTime = new Date(new Date().getTime()/1000*1000); // put on full second
      this.startTime = this.topTime;
    }
    else {
      this.topTime = new Date(this.topTime.getTime()+1000);
    }

    let prevIdx = this.idx;
    this.idx++; // point to new top frame
    if(this.idx > this.size-1) this.idx = 0;
    this.set(this.idx, valueArr);
    this.currentSize++;
    if(this.currentSize > this.size)this.currentSize = this.size;
    console.log("push to " + this.idx + " ready, size now " + this.currentSize + " bins");
    this.calculateWindowValues();
  }

  convertTopEntryToCsvLine() {
    let toTime = this.buf[this.idx].time; //getTime(this.idx);
    let line = toTime.toISOString().substring(0,19) + "\t" + this.buf[this.idx].respTime.toISOString() + "\t";
    for(let c of ["leq_s"]){ //,"leg_5m","leq_1h", "ee"]) {
      for(let vk of Object.keys(this.buf[this.idx][c])) {
        line += this.buf[this.idx][c][vk] + "\t";
      }
    }
    line += "\r\n";
    return line;
  }
}

let measBuffer = null;

function zeroPad(number, digits) {
  let res = ""+number;
  while(res.length < digits) {
    res = "0" + res;
  }
  return res;
}

const parserUSB = serialUSB.pipe(new DelimiterParser({delimiter: '\n'}));
let responsePromise = null;
parserUSB.on('data', (data) => { 
  
  let respTime = new Date();
  console.log("received on serial (USB): " + data.toString()); 
  let start = 0;
  while(data[start] != 0x2) {
    console.error("invalid response byte " + data[start] + ", skipping until <STX> (0x02) is received.");
    start++;
    if(start >= data.length) {
      console.error("reached data end without <STX>");
      return;
    }
  }
  let pos = start+1;
  let clientID = data[pos++];
  let attr = data[pos++];
  let attrStr = attr==0x43?"C":attr==0x41?"A":attr==0x6?"<ACK>":attr==0x15?"<NAK>":"<UNK>";
  console.log("received " + attrStr + " type answer from device " + clientID);
  let response = "";
  while(data[pos] != 0x3) {
    response += String.fromCharCode(data[pos++]);
  }
  let bcc = data[++pos];
  let rbc = 0;
  for(let i = start; i < pos; i++) {
    rbc ^= data[i];
  }
  if(bcc != 0 && bcc != rbc) {
    console.err("response checksum " + rbc + " not matching received bcc " + bcc);
    if(responsePromise)responsePromise.reject("checksum mismatch");
    return;
  }
  let dataStr = "";
  for(let i = 0; i < data.length; i++) {
    //console.log("byte" + i + "[0x" + data[i].toString(16) +"]: "+ String.fromCharCode(data[i]));
    dataStr += String.fromCharCode(data[i]);
  }
  
  if(attr == 0x41) {
    console.log("Response is data block: " + response);
    if(responsePromise && responsePromise.commandName == "DTT") {
      handleMeasurementResponse(respTime, dataStr);
    }
    if(responsePromise)responsePromise.resolve(response);
    return;
  }
  else if(attr == 0x6) {
    console.log("Client confirms command.");
    if(responsePromise)responsePromise.resolve();
    return;
  }
  else if(attr == 0x15) {
    console.error("Client sends error response: ");
    if(responsePromise)responsePromise.reject(response);
    return;
  }

});

let parserAMA = serialAMA.pipe(new ReadlineParser({delimiter: '\r\n'}));
parserAMA.on('data', (data) => { console.log("received on AMA:"+data);});

function serialCommand(commandName) {
  if(commandName.length != 3) {
    console.err("Command must have 3 chars, '" + commandName + "' isnt valid!");
    return;
  }
  return new Promise( (resolve, reject) => {
    setTimeout(()=> {reject("Device did not reply within 5s");},5000);
    responsePromise = {resolve:resolve, reject:reject,commandName:commandName,start:new Date()};
    let payload = new Uint8Array(1024);
  let payloadBytes = 0;
  payload[payloadBytes++] = 0x2;
  payload[payloadBytes++] = (ID&0xff); //commandName == "IDX" ? 0 : (ID&0xff);
  payload[payloadBytes++] = "C".charCodeAt(0);
  for(let i = 0; i < arguments.length; i++) {
    if(i>1) payload[payloadBytes++] = " ".charCodeAt(0); // space between params
    for(let j = 0; j < arguments[i].length; j++) {
      let cc = arguments[i].charCodeAt(j);
      if(cc > 255 || cc < 0) {
        console.error("command arg '" + arguments[i] + "' has invalid character " + cc + " at position " + j);
        return;
      }
      payload[payloadBytes++] = arguments[i].charCodeAt(j);
    }
  }
  payload[payloadBytes++] = 0x3;
  let bcc = 0;
  for(let i = 0; i < payload.length; i++) {
    bcc ^= payload[i];
  }
  payload[payloadBytes++] = bcc;
  payload[payloadBytes++] = 0xd;
  payload[payloadBytes++] = 0x0a;
  console.log("writing " + payloadBytes + " data bytes to serial: ");
  let strR = "";
  for(let i = 0; i < payloadBytes; i++) {
    console.log("byte " + i + " [0x" + payload[i].toString(16) + "]:" + String.fromCharCode(payload[i]));
  }
  //serialAMA.write(payload.subarray(0,payloadBytes));
  serialUSB.write(payload.subarray(0,payloadBytes), () => {console.log("write done")});
  });
}

//serialCommand("HOR", "19 20 30");
//serialCommand("IDX","?");
function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

async function discoverDevice() {
  while(deviceState == 0) {
    try {
      let res = await serialCommand("STA","?");
      console.log("Received from STA?: '\n" + res + "\n'");
      let mState = parseInt(res);
      if(mState == 1) {
        console.log("Measurement is running, stopping...");
	try {
          res = await serialCommand("STA","0");
	  console.log("stopped");
	}
	catch(e) {
	  console.error("Stopping measurement failed: ", e);
	}

      }
      deviceState = 1;
    }
    catch(e) {
      console.error("Error discovering device " + ID + ": " ,e);
      await sleep(1000);
    }
  }
}

async function updateDeviceClock() {
  let ct = new Date();
  try {
    await serialCommand("HOR",""+ct.getHours(),""+ct.getMinutes(),""+ct.getSeconds());
    console.log("device time updated: " + ct);
  }
  catch(e) {
    console.error("Error setting device time ",e);
  }
}


function getFileName(time) {
  return "buffer/"+getCloudFileNameForEndTime(time);
}

async function applyCsvToBuffer(csv) {
  let lines = csv.split("\r\n");
  for(let i = 1; i < lines.length;i++) {
    let cells = line.split("\t");
    let idx = measBuffer.getIndex(new Date(cells[0]));
    if(idx > -1) {
      measBuffer.set(idx, cells.subarray(1,17));
    }
  }
}

async function initBuffer() {
  measBuffer = new MeasurementBuffer(3600);
  measBuffer.init();

  // load current hour file
  let fn = getFileName(measBuffer.startTime);
  try {
    let data = fs.readFileSync(fn);
    applyCsvToBuffer(data);
  }
  catch(e) {
    console.log("no local measurement file for current hour found: " + fn);
  }
  // load prev hour file
  fn = getFileName(new Date(measBuffer.startTime.getTime()-3600000)); // one hour back
  try {
    let data = fs.readFileSync(fn);
    applyCsvToBuffer(data);
  }
  catch(e) {
    console.log("no local measurement file for previous hour found: " + fn);
  }


}

async function initBlobClient() {
  let connStr = config.storageConnectionString;
  if(!connStr || connStr.length == 0) throw "No connection string in config!";
  blobServiceClient = BlobServiceClient.fromConnectionString(config.storageConnectionString);
  containerClient = blobServiceClient.getContainerClient(config.containerName);
  
}

async function startMeasurement() {
  await serialCommand("STA","1");
  console.log("Measurement started");
  await serialCommand("DTT","2","?");
//  await sleep(1000);
//  setInterval(() => {
//    serialCommand("DTT","1","?");
//  },1000);
}

function getCloudFileNameForEndTime(time) {
  let filename = "";
  try {
    filename = time.toISOString().substring(0,4)+"/"+zeroPad(time.getUTCMonth()+1,2)+"/"+zeroPad(time.getUTCDate(),2)+"/"+zeroPad(time.getUTCHours(),2)+".csv";
  }
  catch(e) {
    console.log("no valid time for filename: " + time);
  }
  return filename;
}

let syncing = 0;
async function syncToCloud(){
  if(syncing) return;
  syncing = 1;
  /*let bufferFiles = await new Promise((resolve,reject)=> {
    fs.readdir("buffer", (err,files) => {
      if(err) { reject(err); return; }
      resolve(files);
    });
  });
  let fc = 0;
  for(let bfn of bufferFiles) {
	  
    let dataLines = await new Promise((resolve, reject) => {
      fs.readFile("buffer/"+bfn, {encoding:'utf8'}, (err, data) => {
        if(err) {reject(err); return; }
	resolve(data);
      });
    });
    console.log("read "  +dataLines.length + " bytes from upload buffer file " + bfn);
    if(dataLines.length > 0) {
      let fn = bfn.split('_').join('/');
      console.log("corresponding cloud file is " + fn );
      if(await appendToBlob(fn, dataLines, false)) {
        console.log("appended successfully to blob");
	fc++;
	await new Promise((resolve, reject) => {
	  fs.unlink("buffer/"+bfn, (err)=> {
            if(err) {reject(err);return;}
	    resolve();
	  });
	});
      }
    }
  }// end loop over bufferFiles
  */
  let csvLine = null;
  let lc = 0;
  let totalLines = syncBuf.length;
  while(syncBuf.length > 0){ 
    csvLine = syncBuf.shift();
    let csvTime = csvLine.split("\t")[1];
    console.log("csvTime = " + csvTime);
    csvTime = new Date(csvTime);
    console.log("csvTime = " + csvTime);
    let fn = getCloudFileNameForEndTime(csvTime);
    if(await appendToBlob(fn, csvLine, false)) {
      console.log("appended successfully to blob");
      syncBuf.shift();
    }
    else break;
  }
  console.log("endSyncToCloud, lines synced: " + lc + " out of " + totalLines);

  syncing = 0;
}

const syncBuf = new Array(0);

async function pushTopDataRowToCloud(flush){  
  // convert top row in internal buffer to csv line
  let csvLine = measBuffer.convertTopEntryToCsvLine();
  let fn = getCloudFileNameForEndTime(measBuffer.buf[measBuffer.idx].respTime).split('/').join('_');//new Date(measBuffer.topTime.getTime())).split('/').join('_');
  
  syncBuf.push(csvLine);
  if(flush) syncToCloud();
  //fs.appendFile("buffer/" + fn, csvLine, (err) => {
  //  if(err) {console.error("failed to push csvLine to local buffer file " + fn + ": ", err); return;} 
  //  console.log("line added to local buffer file " + fn+ ": " + csvLine);
    //if(flush)syncToCloud();
  //});
}

async function appendToBlob(fn, data, appendToBuffer) {
  let appendBlobCLient = null;
  try {
    appendBlobClient = await containerClient.getAppendBlobClient(fn);
    let ciner = await appendBlobClient.createIfNotExists();
    if(ciner.succeeded) {
      data = "IntervalEnd\tRespTime\tLeqA\tLeqB\tLeqC\tLeqZ\tLeq6.3Hz\tLeq8Hz\tLeq10Hz\tLeq12.5Hz\tLeq16Hz\tLeq20Hz\tLeq25Hz\tLeq31.5Hz\tLeq40Hz\tLeq50Hz\tLeq63Hz\tLeq80Hz\tLeq100Hz\tLeq125Hz\tLeq160Hz\tLeq200Hz\tLeq250Hz\tLeq315Hz\tLeq400Hz\tLeq500Hz\tLeq630Hz\tLeq800Hz\tLeq1kHz\tLeq1.25kHz\tLeq1.6kHz\tLeq2kHz\tLeq2.5kHz\tLeq3.15kHz\tLeq4kHz\tLeq5kHz\tLeq6.3kHz\tLeq8kHz\tLeq10kHz\tLeq12.5kHz\tLeq16kHz\tLeq20kHz\r\n"+data;
    }
    await appendBlobClient.appendBlock(data, data.length);
    console.log("appended " + data + " to blob");
    return true;
  }
  catch(e) {
    console.error("Failed to append to blob " + fn + ":",e);
    if(appendToBuffer) {
      fs.appendFileSync(bufferFile, data);
      console.log("added to local buffer");
    }
    return false;
  }
}

async function handleMeasurementResponse(respTime, dataStr) {
  let vArr = [new Date(), 0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0]; 
  // add to internal buffer
//  while(measBuffer.currentSize > 0 && respTime.getTime()-measBuffer.topTime.getTime() > 1000) {
//    console.log("internal buffer topTime " + measBuffer.topTime + " is > 1s before respTime " + respTime);
//    vArr[0] = new Date(measBuffer.topTime.getTime()+1000);
//    measBuffer.push(vArr); // add an all zero record to fill the gap
//    pushTopDataRowToCloud(false);
//  }
  dataStr = "0,"+dataStr;
  vArr = dataStr.split(",").map((x)=> {return parseFloat(x);});
  vArr[0] = respTime;
  measBuffer.push(vArr);
  pushTopDataRowToCloud(true);
}

async function startup() {
  await discoverDevice();

  await updateDeviceClock();
  
  await initBuffer();

  await initBlobClient();

  await startMeasurement();
}

async function run() {
  state = "startup";
  while(state == "startup") {
    try {
      await startup();
      state = "running";
      console.log("startup completed successfully.");
    }
    catch(e) {
      console.error("Error while starting up:", e);
      await sleep(5000);
    }
  }

}

run();

//serialAMA.write("data from AMA serial\n");



