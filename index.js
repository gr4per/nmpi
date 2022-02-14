const fs = require('fs');
const SerialPort = require('serialport')
const Readline = SerialPort.parsers.Readline
const Delimiter = require('@serialport/parser-delimiter')

const serialUSB = new SerialPort("/dev/ttyUSB0", {baudRate: 9600});
const serialAMA = new SerialPort("/dev/ttyAMA0", {baudRate: 9600});
const ID = 1;

let deviceState = 0;

class MeasurementBuffer {
  constructor(size) {
    this.size = 3600;
    this.buf = new Array(this.size);
    this.idx = this.size-1;
    this.startIdx = this.idx;
    this.startTime = new Date(new Date().getTime()/1000*1000); // put on full second
    this.topTime = this.startTime;
    for(let i = this.idx; i >= 0;i--) {
      this.buf[i] = {time:new Date(this.startTime.getTime()-1000*i),leq_s:{a:0,b:0,c:0,z:0,o8:0,o16:0,o31:0,o63:0,o125:0,o250:0,o500:0,o1k:0,o2k:0,o4k:0,o8k:0,o16k:0},leq_5m:{a:0,b:0,c:0,z:0,o8:0,o16:0,o31:0,o63:0,o125:0,o250:0,o500:0,o1k:0,o2k:0,o4k:0,o8k:0,o16k:0},leq_1h:{a:0,b:0,c:0,z:0,o8:0,o16:0,o31:0,o63:0,o125:0,o250:0,o500:0,o1k:0,o2k:0,o4k:0,o8k:0,o16k:0}};
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
    let t = this.getTime(idx);
    this.buf[i] = {time: t,leq_s:{a:valueArr[0],b:valueArr[1],c:valueArr[2],z:valueArr[3],o8:valueArr[4],o16:valueArr[5],o31:valueArr[6],o63:valueArr[7],o125:valueArr[8],o250:valueArr[9],o500:valueArr[10],o1k:valueArr[11],o2k:valueArr[12],o4k:valueArr[13],o8k:valueArr[14],o16k:valueArr[15]};
    this.buf[i].ee = {};
    for(let l of Object.keys(this.buf[i].leq_s)) {
      this.buf[i].ee[l] = this.getSPLEnergyEquivalent(this.buf[i].leq_s[l]);
    }
  }

  calculateWindowValues() {
    // define 5m window
    let dt = 5*60*1000;
    if(this.topTime.getTime() - this.startTime.getTime() < dt) {
      dt = (this.topTime.getTime()-this.startTime.getTime());
    }
    let start5m = idx - dt/1000;
    if(idx < 0) idx = idx-this.size;
    console.log("5m start idx = " + this.getTime(start5m));
    let target = this.buf[this.idx];
    target.leq_5m = {};
    for(let l of Object.keys(target.ee))target.leq_5m[l]=0;
    let binCount = 0;
    for(let i = start5m; idx != this.idx) {
      if(i > this.size-1) i = 0;
      for(let l of Object.keys(target.ee)){
	 target.leq_5m[l] += this.buf[i].ee[l];
      }
      binCount++;
    }
    //now divide energy equivalent by bins (=s) to get power, then convert to SPL
    for(let l of Object.keys(target.leq_5m)) {
      target.leq_5m[l] /= binCount;
      target.leq_5m[l] = 10*Math.log10(target.leq_5m[l]);
    }
  }

  push(valueArr) {
    let prevIdx = this.idx;
    this.idx++:
    if(this.idx > this.size-1) this.idx = 0;
    this.topTime = new Date(this.topTime.getTime()+1000);
    this.set(this.idx, valueArr);
    calculateWindowValues();
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

const parserUSB = serialUSB.pipe(new Delimiter({delimiter: '\n'}));
let responsePromise = null;
parserUSB.on('data', (data) => { 
  
  let respTime = new Date();
  console.log("received on serial (USB): " + data.toString()); 
  let start = 0;
  while(data[start] != 0x2) {
    console.err("invalid response byte " + data[start] + ", skipping until <STX> (0x02) is received.");
    start++;
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
    if(responsePromise && responsePromise.commandName == "DOT") {
      let filename = 'remm_'+responsePromise.start.toISOString().substring(0,13)+zeroPad(responsePromise.start.getUTCMinutes(),2);
      filename += zeroPad(responsePromise.start.getUTCSeconds(),2)+".oct";
      if(!fs.existsSync(filename)) {
        fs.appendFileSync(filename, "Date\tTime\tFilter\tLAeq\tLBeq\tLCeq\tLZeq\t8Hz\t16Hz\t31.5Hz\t63Hz\t125Hz\t250Hz\t500Hz\t1kHz\t2kHz\t4kHz\t8kHz\t16kHz\r\n");
      }
      fs.appendFileSync(filename, respTime.toISOString().substring(0,10) + "\t" + zeroPad(respTime.getUTCHours(),2)+zeroPad(respTime.getUTCMinutes(),2)+zeroPad(respTime.getUTCSeconds(),2)+".0\t"+response.replace(/,/g,"\t")+"\r\n");
    }
    if(responsePromise)responsePromise.resolve(dataStr);
    return;
  }
  else if(attr == 0x6) {
    console.log("Client confirms command.");
    if(responsePromise)responsePromise.resolve();
    return;
  }
  else if(attr == 0x15) {
    console.error("Client sends error response: ");
    if(responsePromise)responsePromise.reject(dataStr);
    return;
  }

});

const parserAMA = new Readline();
serialAMA.pipe(parserAMA);
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
  payload[payloadBytes++] = commandName == "IDX" ? 0 : (ID&0xff);
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
      let res = await serialCommand("IDX","?");
      console.log("Received ID " + res + " from IDX? broadcast");
      ID = parseInt(res);
      deviceState = 1;
    }
    catch(e) {
      console.error("Error finding device via broadcast: ",e);
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
  return ""+time.getUTCYear()+"/"+time.getUTCMonth()+"/"+time.getUTCDay()+"/"+time.getUTCHour()+".csv";
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

async function startup() {
  await discoverDevice();

  await updateDeviceClock();
  
  await initBuffer();

}

async function run() {
  state = "startup";
  while(state == "startup") {
    try {
      await startup();
      state = running;
      console.log("startup completed successfully.");
    }
    catch(e) {
      console.error("Error while starting up:", e);
      await sleep(5000);
    }
  }

  let ct = new Date();
  await discoverDevice();

  try {
    await updateDeviceClock();
  }
  catch(e) {
    console.error("Error in startup ",e);
  }

  await serialCommand("HOR",""+ct.getHours(),""+ct.getMinutes(),""+ct.getSeconds());

  //await serialCommand("MEM","0");

  await serialCommand("STA", "0");

//  await serialCommand("DOT","2", "?");
}

run();

//serialAMA.write("data from AMA serial\n");



