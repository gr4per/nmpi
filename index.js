const fs = require('fs');
const {WebSocket} = require('ws');
const {SerialPort} = require('serialport')
const {ReadlineParser} = require('@serialport/parser-readline');
const {DelimiterParser} = require('@serialport/parser-delimiter')
const {BlobServiceClient} = require('@azure/storage-blob');
const {Dsp206} = require('./node_modules/dsp206/dsp206.js');

let serialUSB = null;
const serialAMA = new SerialPort({path:"/dev/ttyAMA0", baudRate: 9600});
const config = require("./config.json");

let ID = 1;
let deviceState = 0;

let state = "new";
let blobServiceClient;
let containerClient;
let lastTimeSync = null;
let lastSerialData = new Date();

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

let uplink = {
  joinTime:null, // Date object
  nmdId:config.containerName,
  nmdClient:null,
  nmdClientId:null,
  //https:false,
  //serverAddress:"192.168.188.20",
  //port:3000,
  serverAddress:"gr4per-nms.azurewebsites.net",
  port:443,
  https:true,
  serverVersion:null,
  apiToken:null,
  lastPing:null,
  successfulJoin:false,
  status:"offline",
  retry:0
}
uplink.apiToken = config.nmdToken;

uplink.interval = setInterval(async ()=>{
  if(state != "running") return;
  if(uplink.nmdClient) { 
    if( uplink.status == "offline" ||(new Date().getTime() - uplink.lastPing.getTime()) > 3000) {
      console.log("" + new Date() + ": found stale/broken server connection not pinged since " + uplink.lastPing + ", leaving, then resetting nmdClient and scheduling reconnect...");
      try {
        sendRemoteCommand({command:"leave",params:[false]});           
      }
      catch(e) {
        console.log("not able to send leave command: " + e);
      }
      try {
        uplink.nmdClient.close();
      }
      catch(e) {
        console.log("failed to close socket: " + e);
      }
      uplink.nmdClient = null;
      uplink.successfulJoin = false;
      setTimeout(joinNMS,1000);
      return;
    }
    else {
      //console.log("" + new Date() + ": sending ping to server");
      sendRemoteCommand({command:"clientPing",params:[]});
    }
  }
  else {
    uplink.nmdClient = null;
    if(uplink.apiToken) {
      clearTimeout();
      console.log("no nmdClient, setting time out to re connect to NMS with nmdId " + uplink.nmdId);
      setTimeout(joinNMS,1000);
    }
    else {
      console.log("cannot connect to NMS: no API token");
    }
  }
},2000);

function sendRemoteCommand(cmdJson) {
  if(uplink.nmdClient) {
    try {
      uplink.nmdClient.send(JSON.stringify(cmdJson));
    }
    catch(e) {
      console.error("error sending command to server:", e);
    }
  }
  else {
    console.log("cannot send command " + cmdJson.command + " to server: no nmdClient");
  }
}

async function joinNMS() {
  console.log("joinNMS called, retry = " + uplink.retry++);
  if(!uplink.nmdId) {
    console.log("need nmdId to join nmd.");
    return;
  }
  if(uplink.joinTime && new Date().getTime()-uplink.joinTime.getTime() < 5000) {
    console.log("previous join attempt not timed out, skipping...");
    return;
  }
  uplink.joinTime = new Date();
  console.log("trying to join nmd " + uplink.nmdId + "...");
  let successfulJoin = false;
  console.log("join nmd called, nmdId = " + uplink.nmdId);
  try {
    uplink.nmdClient = new WebSocket('ws'+(uplink.https?"s":"")+'://'+uplink.serverAddress+':'+uplink.port+'/api/nmds/' + uplink.nmdId + '/join?token=' + uplink.apiToken + '&mode=source');
  }
  catch(err) {
    console.error(err);
  }
  uplink.nmdClient.onerror = (event) => {
    console.error("nmdClient error: ", event);
  }
  
  uplink.lastPing = new Date(); // start with stale date
  console.log("" + new Date() + ": created ws");
  uplink.nmdClient.onopen = (event) => {
    //log("event = " + JSON.stringify(event));
    console.log("" + new Date() + ": webSocket successfully opened, adding ping/pong timer");
    uplink.lastPing = new Date(); // start with stale date
    uplink.retry = 0; // reset after connect
    uplink.status = "online";
  };
  uplink.nmdClient.onmessage = (messageEvent) => {
    uplink.lastPing = new Date(); // start with stale date
    let message = messageEvent.data;
    let messageObj = JSON.parse(message);
    let trace = true;
    
    if(messageObj.command) {
      console.log("received server command on nmClient[" + uplink.nmdClientId + "]: " + JSON.stringify(messageObj));
      //log("received server command: " + messageObj.command);
      switch(messageObj.command) {
        case "id":
          uplink.nmdClientId = messageObj.params[0];
          uplink.serverVersion = messageObj.params[1];
          break;
        case "drop":
          uplink.status = "offline";
          console.log("server asked to drop connection.");
          uplink.nmdClient.close();
          uplink.nmdClient = null;
          break;
        case "pong":
          //log("" + new Date() + ": received pong, updating lastPing");
          uplink.lastPing = new Date();
          break;
        case "stream":
          console.log("received stream signal from server to start syncing buffer from " + messageObj.params[0]);
          uplink.serverSyncFromTime = messageObj.params[0];
          if(uplink.serverSyncFromTime == null) {
            // server sending null means all existing buffer rows to be synced, this is max 1 day
            uplink.serverSyncFromTime = new Date(new Date().getTime() -24*3600*1000);
          }
          else {
            uplink.serverSyncFromTime = new Date(uplink.serverSyncFromTime);
          }
          uplink.successfulJoin = true;
          break;
        case "dropBefore":
          console.log("received dropBefore " + messageObj.params[0] +  " signal from server");
          let serverCommitTime = messageObj.params[0];
          dropBackupBufferBefore(new Date(serverCommitTime));
          break;
        default:
          console.error("command not implemented");
      }
    }
    else if(messageObj.error) {
      console.error("received server error message: " + messageObj.error);
      console.error("received server error!");
      return;
    }
  };
  let timeout = 5000;
  let startTime = new Date().getTime();
  while(!uplink.successfulJoin && new Date().getTime() - startTime < timeout) {
    await sleep(100);
  }
  if(uplink.successfulJoin) {
    console.log("joined NMS successfully!");
  }
}
  
class MeasurementBuffer {
  constructor(size) {
    this.size = 3600;
    this.currentSize = 0;
    this.buf = new Array(this.size);
    this.idx = this.size-1; // pointing to top, i.e. last written record
    this.startIdx = this.idx;
    this.startTime = new Date();
    this.startTime.setMilliseconds(0);    // put on full second, this is the integration END time of the interval covered by the bin
    this.topTime = this.startTime; // again, this is the END time of the interval, i.e. bin 13:26:47 covers integration from 13:26:46-13:26:47
  }

  init() {
    for(let i = this.idx; i >= 0;i--) {
      let ev = [this.getTime(i),0]; // time and filter setting, now add the bands ...
      for(let j = 0; j < bands.length; j++) {
        ev.push(0.0);
      }
      this.set(i, ev);
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

  /**
   * Expects array with responseTime (Date) at pos 0
   * filter profile (int) at pos 1
   * and then for each band one number with Leq value
   */
  set(index, valueArr) {
    valueArr = valueArr.slice();
    let t = this.getTime(index);
    let rt = valueArr.shift();
    this.buf[index] = {time: t,respTime:rt,leq_s:{a:valueArr[1],b:valueArr[2],c:valueArr[3],z:valueArr[4],t6:valueArr[5],t8:valueArr[6],t10:valueArr[7],t12:valueArr[8],t16:valueArr[9],t20:valueArr[10],t25:valueArr[11],t31:valueArr[12],t40:valueArr[13],t50:valueArr[14],t63:valueArr[15],t80:valueArr[16],t100:valueArr[17],t125:valueArr[18],t160:valueArr[19],t200:valueArr[20],t250:valueArr[21],t315:valueArr[22],t400:valueArr[23],t500:valueArr[24],t630:valueArr[25],t800:valueArr[26],t1000:valueArr[27],t1250:valueArr[28],t1600:valueArr[29],t2000:valueArr[30],t2500:valueArr[31],t3150:valueArr[32],tk4:valueArr[33],tk5:valueArr[34],t6k:valueArr[35],t8k:valueArr[36],t10k:valueArr[37],t12k:valueArr[38],t16k:valueArr[39],t20k:valueArr[40]},ee:{}};
    //console.log("set, valueArr = " + JSON.stringify(valueArr)+ "\nlen = " + valueArr.length + "\nrecord so far:" + JSON.stringify(this.buf[index],null,2)+"\nleq_s keys: " + JSON.stringify(Object.keys(this.buf[index]["leq_s"])));
    for(let l of Object.keys(this.buf[index]["leq_s"])) {
      if(isNaN(this.buf[index]["leq_s"][l])) {
        console.log("cannot set valueArr " + JSON.stringify(valueArr) + ": value '" + l + "'=" + this.buf[index]["leq_s"][l] + " is not a number. leq_s["+index+"] = " + JSON.stringify(this.buf[index]["leq_s"]));
        console.error(new Error("this didnt work out as expected"))
        process.exit(1);
      }
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
    let start5m = idx - dt/1000+1;
    if(start5m < 0) start5m = this.size+start5m;
    //console.log("5m start idx = " + start5m + ", time = " + this.getTime(start5m));
    this.aggregateWindow(start5m, "leq_5m");

    dt = 10*1000;
    if(this.topTime.getTime() - this.startTime.getTime() < dt) {
      dt = (this.topTime.getTime()-this.startTime.getTime());
    }
    let start10s = idx - dt/1000+1;
    if(start10s < 0) start10s = this.size+start10s;
    //console.log("10s start idx = " + start10s + ", time = " + this.getTime(start10s));
    this.aggregateWindow(start10s, "leq_10s");

    // define 1h window
    let start1h = idx+1;
    if(start1h > this.size-1)start1h = start1h-this.size;
    //console.log("1h start index is " + start1h + ", time = " + this.buf[start1h].time);
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
        if(!this.buf[i]["ee"]) {
          console.error("measurementBuffer[" + i + "] is not properly initialized: " + JSON.stringgify(this.buf[i]));
          process.exit(1);
        }
        target[name][l] += this.buf[i]["ee"][l];
      }
      binCount++;
    }
    //console.log("binCount = " + binCount);
    //now divide energy equivalent by bins (=s) to get power, then convert to SPL
    for(let l of Object.keys(target["ee"])) {
      target[name][l] /= binCount;
      target[name][l] = 10*Math.log10(target[name][l]);
    }
    //console.log("aggregate window done");
  }

  /* takes a value array as argument that has Date object (measurement arrival time) at index 0,
   * filter setting 0 = Z at index 1,
   * followed by one float per band for the 1/3 octave leq values
   */
  push(valueArr) {
    if(valueArr.length != bands.length+2) {
      console.log("cannot push " + JSON.stringify(valueArr) + ", incorrect size: " + valueArr + ", expected " + (bands.length+2));
      console.error(new Error("oh oh"));
      process.exit(1);
    }
    let prevSize = this.currentSize;
    let prevIdx = this.idx;
    if(this.currentSize == 0) { // on first push we set start time
      this.topTime = new Date(valueArr[0]); // this is response time, make sure we date it back as the result can only come after the second integral has fully elapsed
      if(this.topTime.getMilliseconds() < 500) {
        this.topTime = new Date(this.topTime.getTime()-1000);
        console.log("Dating topTime back one second based on passed respTime " + valueArr[0].toISOString());
      }
      this.topTime.setMilliseconds(0);      // put on full second
      this.startTime = this.topTime;
      console.log("push to empty measurement buffer, setting start time and top time to " + this.topTime);
    }
    else {
      this.topTime = new Date(this.topTime.getTime()+1000);
    }


    this.idx++; // point to new top frame
    if(this.idx > this.size-1) this.idx = 0;
    this.set(this.idx, valueArr);

    // compare prev data with current
    if(prevSize > 0) {
      let identical = true;
      let prevValue = this.buf[prevIdx];
      let currentValue = this.buf[this.idx];
      for(let k of Object.keys(prevValue.leq_s)) {
        if((prevValue.leq_s[k] != currentValue.leq_s[k]) || currentValue.leq_s[k] == 0){ // exclude zero values as they can legally occurr as duplicates to fill buffer slots
          identical = false;
          break;
        }
      }
      if(identical) {
        console.error("duplicate value " + JSON.stringify(valueArr));
        // restart measurement
        try {
          restartMeasurement();
        }
        catch(e) {
          console.error("unable to stop /restart measurement: ", e);
        }
      }
    }

    this.currentSize++;
    if(this.currentSize > this.size)this.currentSize = this.size;
    console.log("push to " + this.idx + " ready, size now " + this.currentSize + " bins");
    this.calculateWindowValues();
    this.buf[this.idx]["attn"] = {};//initialize attenuation
    for(let i = 0;i< bands.length;i++) {
      this.buf[this.idx]["attn"][bands[i]]=0.0;
      if(attnInfo[bands[i]]) {
        this.buf[this.idx]["attn"][bands[i]]=attnInfo[bands[i]].level;
      }
    }
  }

  convertTopEntryToCsvLine() {
    let toTime = this.buf[this.idx].time; //getTime(this.idx);
    let line = toTime.toISOString().substring(0,19) + "\t" + this.buf[this.idx].respTime.toISOString() + "\t";
    for(let c of ["leq_s","leq_5m","leq_1h","attn"]) {
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

let parserUSB = null;

let responsePromise = null;
function handleData(data) {
  
  let respTime = new Date();
  lastSerialData = respTime; // track each request so we can detect when we lost the PCE 430
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
    console.error("response checksum " + rbc + " not matching received bcc " + bcc);
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
      handleMeasurementResponse(respTime, response);
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

}

let parserAMA = serialAMA.pipe(new ReadlineParser({delimiter: '\r\n'}));
parserAMA.on('data', (data) => { console.log("received on AMA:"+data);});

function serialCommand(commandName) {
  if(commandName.length != 3) {
    console.err("Command must have 3 chars, '" + commandName + "' isnt valid!");
    return;
  }
  return new Promise( (resolve, reject) => {
    let timeout = setTimeout(()=> {
      if(responsePromise && responsePromise.commandName == commandName) {
        reject("Device did not reply within 5s to " + commandName + " command.");
      }
      else {
        console.log("5s timer expired on command " + commandName + " but not matching responsePromise command " + responsePromise.commandName);
      }
    },5000);
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

async function initSerialDevice() {
  while(deviceState == 0) {
    console.log("recreating serial port...");
    serialUSB = new SerialPort({path:"/dev/ttyUSB0", baudRate: 9600});
    parserUSB = serialUSB.pipe(new DelimiterParser({delimiter: '\n'}));
    parserUSB.on('data', handleData);
    
    try {
      let res = await serialCommand("STA","?");
      console.log("Received from STA?: '\n" + res + "\n'");
      let mState = parseInt(res);
      if(mState == 1) {
        console.log("Measurement is running, stopping...");
        try {
          res = await serialCommand("STA","0");
          console.log("any running measurement now stopped");
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
    lastTimeSync = ct;
  }
  catch(e) {
    console.error("Error setting device time ",e);
    process.exit(1);
  }
}


function getFileName(time) {
  return "buffer/"+getCloudFileNameForEndTime(time).replace(/\//g, "-");
}

async function applyJsonLinesToBuffer(csv, start) {
  // we need an empty value template in case the file is not complete we have to fill gaps with zeros
  let ev = new Array(0);
  ev.push(new Date());
  ev.push(0); // filter value
  for(let b of Object.values(bandLabelMap)) {
    ev.push(0.0);
  }

  let lines = csv.split("\r\n");
  console.log("going to process " + lines.length + " lines.");
  for(let i = 0; i < lines.length;i++) {
    let line = lines[i];
    if(line.length < 30 || line.charCodeAt(0) == 0) continue;
    console.log("applying line " + line.substring(0,33));
    try {
      line = JSON.parse(line);
    }
    catch(e) {
      console.error("error in buffer file, cannot parse json '" + line + "':",e);
      let bytes = "";
      for(let j = 0; j < line.length; j++) {
        bytes+=" 0x"+line.charCodeAt(j);
      }
      console.log("bytes = " + bytes);
      continue;
    }
    
    let lineTime = new Date(line.time);
    lineTime.setMilliseconds(0);
    console.log("lineTime = " + lineTime);
    line.time = lineTime;
    if(start && lineTime.getTime() < start.getTime()) {
      console.log("skipping line " + i + " at " + lineTime);
      continue;
    }
    let nextIdx = measBuffer.idx+1;
    while(nextIdx >= measBuffer.size) { nextIdx -= measBuffer.size; }
    if(measBuffer.currentSize == 0) {
      // insert on current position
      console.log("measurement buffer empty, setting start time to first line ingested: " + lineTime);
      measBuffer.topTime = measBuffer.startTime = lineTime.getMilliseconds() > 300 ? lineTime: new Date(lineTime.getTime()-1000); // put one second back because of jitter
      measBuffer.topTime.setMilliseconds(0);
      measBuffer.buf[nextIdx] = line;
    }
    else {
      let prevEntry = measBuffer.buf[measBuffer.idx];
      let insertTime = new Date(measBuffer.topTime.getTime()+1000);
      while(lineTime.getTime() > insertTime.getTime()) {
        console.error("reading buffer, next insert time " + insertTime.toISOString() + ", mismatching lineTime is " + lineTime.toISOString() + ", adding zero row");
        measBuffer.push(ev);
        nextIdx = measBuffer.idx+1;
        while(nextIdx >= measBuffer.size) { nextIdx -= measBuffer.size; }
        insertTime = new Date(measBuffer.topTime.getTime()+1000);
      }
      measBuffer.buf[nextIdx] = line;
    }
    measBuffer.topTime = lineTime;
    measBuffer.topTime.setMilliseconds(0);
    measBuffer.currentSize = Math.min(measBuffer.currentSize+1, measBuffer.size);
    measBuffer.idx = nextIdx;
  }
}

async function initBuffer() {
  measBuffer = new MeasurementBuffer(3600);
  measBuffer.init();
  let now = new Date();
  let start = new Date(now.getTime());
  start.setMinutes(0);
  start.setSeconds(0);
  start.setMilliseconds(0);
  let ev = new Array(0);
  ev.push(new Date());
  ev.push(0); // filter value
  for(let b of Object.values(bandLabelMap)) {
    ev.push(0.0);
  }


  // load prev hour file
  let prevHourStart = new Date(now.getTime()-3600000);
  let fn = getFileName(prevHourStart); // one hour back
  try {
    console.log("trying to load previous hour bufferFile " + fn);
    let data = fs.readFileSync(fn).toString();
    applyJsonLinesToBuffer(data, start);
  }
  catch(e) {
    console.log("no local measurement file for previous hour found: " + fn);
  }

  let currentHourStart = new Date(prevHourStart.getTime()+3600*1000);
  while(measBuffer.topTime.getTime() < currentHourStart.getTime()-1000) {
    measBuffer.push(ev);
    console.log("pushed empty row to measBuffer to fill prev hour, top now " + measBuffer.topTime);
  }

  // load current hour file
  fn = getFileName(start);
  try {
    console.log("trying to load current hour bufferFile " + fn);
    let data = fs.readFileSync(fn).toString();
    applyJsonLinesToBuffer(data);
  }
  catch(e) {
    console.log("no local measurement file for current hour found: " + fn);
  }
  console.log("buffer after load = (currentSize ="  + measBuffer.currentSize + ")");
  let earliestIdx = measBuffer.idx-measBuffer.currentSize;
  if(earliestIdx < 0)earliestIdx+= measBuffer.size;
  console.log("startIdx " + earliestIdx + ", time " + measBuffer.getTime(earliestIdx) + " dataTime " + measBuffer.buf[earliestIdx].time);
  console.log("topIdx " + measBuffer.idx + ", time " + measBuffer.topTime + ", getTime() = " + measBuffer.getTime(measBuffer.idx) + " dataTime " + measBuffer.buf[measBuffer.idx].time);
  
  while(new Date().getTime() - measBuffer.topTime.getTime() > 2000) {
    measBuffer.push(ev);
    console.log("pushed empty row to measBuffer, top now " + measBuffer.topTime);
  }
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


/**
 *
 */
async function stopMeasurement() {
  let res = null;
  try {
    res = await serialCommand("STA","0");
    console.log("any running measurement now stopped");
  }
  catch(e) {
    console.error("failed to stop measurement: ", e);
    return false;
  }
  return true;
}

/**
 *
 */
async function restartMeasurement() {
  if(await serialCommand("STA","0")) {
    console.log("measurement now stopped");
  }
  else {
    console.log("stop failed: measurement wasn't running");
  }
  try {
    res = await startMeasurement();
  }
  catch(e) {
    console.error("failed to restart measurement: ", e);
  }
}

/**
 *
 */
async function startMeasurement() {
  try {
    await serialCommand("STA","1");
    console.log("Measurement started");
  }
  catch(e) {
    console.error("failed to start measurement: ", e);
  }
  try {
    await serialCommand("DTT","2","?");
  }
  catch(e) {
    console.error("failed to start dtt push: ", e);
  }
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

function getCsvTime(csvLine) {
  let csvTime = csvLine.split("\t")[0]+".000Z";
  return new Date(csvTime);
}

/**
 * skims the backup buffer in reverse order to find 
 * the index of the first entry newer than date
 */
function getBackupBufferIndex(date) {
  let i = 0;
  for(i = backupBuffer.length-1; i >= 0;i--) { 
    let el = backupBuffer[i];
    let csvTime = getCsvTime(el);
    if(csvTime.getTime() > uplink.serverSyncFromTime.getTime()) {
      ;
    }
    else {
      i++;
      break;
    }
  }
  return i;
}

function dropBackupBufferBefore(date) {
  let i = getBackupBufferIndex(date);
  if(i>0) {
    console.log("removing first " + i + " elements of backupBuffer, older than " + date);
    backupBuffer.splice(0, i);
  }
}

let syncing = 0;
async function syncToCloud(){
  if(uplink.status != "online") {
    console.log("syncToCloud: skip because status isnt online...");
    return;
  }
  if(syncing) {
    console.log("sync to cloud in progress, skipping re-entry");
    return;
  }
  syncing = 1;
  // first figure out how far back we have to go
  if(uplink.serverSyncFromTime) {
    console.log("skimming backupBuffer to re-sync all entries from " + uplink.serverSyncFromTime);
    let i = getBackupBufferIndex(uplink.serverSyncFromTime);
    let transfer = backupBuffer.splice(i,backupBuffer.length-i);
    syncBuf = transfer.concat(syncBuf);
    
    console.log("pushed " + (backupBuffer.length-i) + " elements back to sync Buffer");
    uplink.serverSyncFromTime = null;
  }
  let csvLine = null;
  let lc = 0;
  let totalLines = syncBuf.length;
  let data = "";
  for(let i = 0; i < syncBuf.length; i++) {
    data += syncBuf[i];
    //console.log("added syncBuf[" + i + "] of " + syncBuf.length + ", data now " + data.toString());
    lc++;
  }
  try {
    uplink.nmdClient.send(data.toString());
    backupBuffer = backupBuffer.concat(syncBuf);
    syncBuf = [];
  }
  catch(e) {
    console.error("failed to write syncBuf to NMS: ", e);
    uplink.status = "offline";
    lc = 0;
  }
  console.log("endSyncToCloud, lines synced: " + lc + " out of " + totalLines);

  syncing = 0;
}

let backupBuffer = [];
function addToBackupBuffer(el) {
  backupBuffer.push(el);
  if(backupBuffer.length > 86400) {
    backupBuffer = backupBuffer.slice(backupBuffer.length -86400+3600, backupBuffer.length); // cut one hour plus excess
  }
}

let streamBuffer = [];
let switchingStream = false;

async function pushToBuffer(fn, jsonLine) {  
  //console.log("target filename = " + fn);
  if(fn == currentBufferFileName) {
    currentBufferFileStream.write(jsonLine);
  }
  else {
    if(switchingStream) {
      streamBuffer.push(jsonLine);
      console.log("stream switch in progress, placing jsonLine to backLog");
      return;
    }
    switchingStream = true;
    console.log("filename " + fn + " not matching current stream target: " + currentBufferFileName);
    let fsStart = new Date(); // measure how long it takes
    if(currentBufferFileStream) {
      try {
        currentBufferFileStream.end();
      }
      catch(e) {
        console.error("failed to close current buffer: " + currentBufferFileName + ": ", e);
      }
    }
    let pos = 0;
    let stats = null;
    try {
      stats = await new Promise((resolve, reject)=>{
        fs.stat("buffer/"+fn, (err, stats) => {
          if(err) {
            // file does not exist
            console.log("file " + fn + " not found in buffers.");
            reject(err);
          }
          else {
            resolve(stats);
          }
        });
      });
      pos = stats.size;
      console.log("file exists, size = " + pos);
    }
    catch(err) {
      // 
      console.log("file " + fn + " not existing, creating");
      let fd = null;
      try {
        fd = await new Promise( (resolve, reject) => {
          fs.open("./buffer/"+fn, "w+",(err,fd) => {
            if(err) {
              reject(err);
            }
            else {
              resolve(fd);
            }
          });
        });
      }
      catch(e) {
        console.error("failed to create file " + fn + " in buffer/: ", e);
      }
    }
    console.log("creating new writeStream to buffer/" + fn + " starting from pos " + pos);
    currentBufferFileStream = fs.createWriteStream("buffer/"+fn, {start:pos});
    let flushCount = streamBuffer.length+1;
    currentBufferFileStream.write(jsonLine);
    for(let l of streamBuffer) {
      currentBufferFileStream.write(l);
    }
    currentBufferFileName = fn;
    streamBuffer = [];
    switchingStream = false;
    console.log("updated write stream and flushed " + flushCount + " lines.");
    let duration = new Date().getTime() - fsStart.getTime();
    console.log("new file stream setup took " + duration + " ms.");
  }
}
    
let syncBuf = [];

let currentBufferFileStream = null;
let currentBufferFileName = null;

async function pushTopDataRowToCloud(flush){  
  // convert top row in internal buffer to csv line
  let csvLine = measBuffer.convertTopEntryToCsvLine();
  let jsonLine = JSON.stringify(measBuffer.buf[measBuffer.idx]) +"\r\n";
  if(measBuffer.buf[measBuffer.idx].leq_s["a"] != 0) {
    //let fn = getCloudFileNameForEndTime(measBuffer.buf[measBuffer.idx].respTime).split('/').join('_');//new Date(measBuffer.topTime.getTime())).split('/').join('_');
    
    syncBuf.push(csvLine);
    if(flush) syncToCloud();
  }
  else {
    console.log("skipping push to cloud for row " + csvLine.substring(0,19) + " because it is zeros only");
  }
  let fn = getCloudFileNameForEndTime(measBuffer.buf[measBuffer.idx].time).replace(/\//g, "-");
  pushToBuffer(fn, jsonLine);    
}

let bandLabelMap = {"A":"a","B":"b","C":"c","Z":"z","6.3Hz":"t6","8Hz":"t8","10Hz":"t10","12.5Hz":"t12","16Hz":"t16","20Hz":"t20","25Hz":"t25",
    "31.5Hz":"t31","40Hz":"t40","50Hz":"t50","63Hz":"t63","80Hz":"t80","100Hz":"t100","125Hz":"t125","160Hz":"t160",
    "200Hz":"t200","250Hz":"t250","315Hz":"t315","400Hz":"t400","500Hz":"t500","630Hz":"t630","800Hz":"t800","1kHz":"t1000",
    "1.25kHz":"t1250","1.6kHz":"t1600","2kHz":"t2000","2.5kHz":"t2500","3.15kHz":"t3150","4kHz":"t4k","5kHz":"t5k","6.3kHz":"t6k",
    "8kHz":"t8k","10kHz":"t10k","12.5kHz":"t12k","16kHz":"t16k","20kHz":"t20k"};
let bands = Object.keys(bandLabelMap);
let header = "IntervalEnd\tRespTime\t";
for(let i = 0; i < bands.length;i++) {
  header += "Leq"+bands[i]+"\t";
}
for(let i = 0; i < bands.length;i++) {
  header += "Leq"+bands[i]+"_a300\t";
}
for(let i = 0; i < bands.length;i++) {
  header += "Leq"+bands[i]+"_a3600\t";
}
for(let i = 0; i < bands.length;i++) {
  header += "Leq"+bands[i]+"_attn\t";
}

let lastDrop = null;

async function handleMeasurementResponse(respTime, dataStr) {
  if(deviceState != 1) {
    console.log("ignoring measurement response because device state not 1");
    return;
  }
  let vArr = [new Date(),0]; // time and filter setting 
  for(let i = 0; i < bands.length;i++) {vArr.push(0.0);}
  // add to internal buffer
  while(measBuffer.currentSize > 0 && respTime.getTime()-measBuffer.topTime.getTime() > 2500) {
    console.log("internal buffer topTime " + measBuffer.topTime + " is > 2.5s before respTime " + respTime + " pushing zero fill value");
    vArr[0] = new Date(measBuffer.topTime.getTime()+1000);
    measBuffer.push(vArr); // add an all zero record to fill the gap
    pushTopDataRowToCloud(false);
  }
  if(measBuffer.topTime.getTime()+1000 > respTime.getTime()) {
    console.log("received data at " + respTime + " but buffer top already at " + measBuffer.topTime);
    // if we drop more than one record every 3 hours, the clock would be off too much
    if(lastDrop && new Date().getTime()-lastDrop.getTime() < 3*3600*1000) { 
      console.log("lastDropped record at " + lastDrop + ", dropping too many.");
      console.log("buffer top = " + JSON.stringify(measBuffer.buf[measBuffer.idx]));
      let prevIdx = measBuffer.idx-1;
      if(prevIdx <0)prevIdx+=measBuffer.size;
      console.log("buffer top-1 = " + JSON.stringify(measBuffer.buf[prevIdx]));
      process.exit(1);
    }
    lastDrop = respTime;
    return;
  }
  //console.log("dataStr = '" + dataStr + "'");
  dataStr = "0,"+dataStr; // PCE430 data string starts with filter setting, then one entry per band
  vArr = dataStr.split(",").map((x)=> {return parseFloat(x);});
  vArr[0] = respTime;
  if(vArr.length > bands.length+2) {
    vArr.pop(); // pop a trailing integer
  }
  measBuffer.push(vArr);
  pushTopDataRowToCloud(true);

  // now derive attenuation 
  updateAttenuation();
}

let updAttn = false;
let attnInfo = {};
for(let i = 0; i < bands.length;i++) {
  attnInfo[bands[i]] = {lastUpdate:null,level:0.0,v5m:null,v1h:null};
}
async function updateAttenuation_old() {
  if(updAttn) { console.log("update attn in progress, skipping");} // prevent multiple entry
  updAttn = true;
  let base = JSON.parse(JSON.stringify(measBuffer.buf[measBuffer.idx])); // deep copy
  //console.log("update attn on record ", base);
  for(let i = 0; i < bands.length; i++) {
    let bandConfig = remoteConfig.bandConfig[bands[i]];
    if(!bandConfig) continue;
    let band = bands[i];
    let lbl = bandLabelMap[band];
    //console.log("updating attn for band " + band + ", lbl " + lbl);
    // is the 5m value over the limit
    let ai = attnInfo[band];
    let oldLevel = ai.level;
    if(base["leq_5m"][lbl] > bandConfig.limit5m) {
      // has it been attenuated before?
      //console.log("band " + band + " over limit: " + base["leq_5m"][lbl] + ", limit = " + bandConfig.limit5m);
      if(ai.lastUpdate) {
        if(new Date().getTime() - ai.lastUpdate.getTime() < bandConfig.minIncDelay) {
          continue; // do nothing yet, wait for delay to elapse
        }
        else {
          if(base["leq_5m"][lbl] > ai.v5m) { // it has continued to rise, attenuation not enough
            if(ai.level < bandConfig.limit5m-base["leq_5m"][lbl]) {
              console.log("5m over limit and rising, current attenuation higher than limit-5m, so not resetting.");
              ai.lastUpdate = new Date();
              ai.v5m = base["leq_5m"][lbl];
            }
            else {
              console.log("increasing attn for " + bands[i] + " 5m has risen from " + ai.v5m + " at " + ai.lastUpdate + " to " + base["leq_5m"][lbl] + " now.");
              ai.lastUpdate = new Date();
              ai.v5m = base["leq_5m"][lbl];
              ai.level = bandConfig.limit5m-base["leq_5m"][lbl];
            }
          }
          else {// 5m is dropping, no need to action
                  ;
          }
        }
      }
      else {
        ai.lastUpdate = new Date();
        ai.level = bandConfig.limit5m-base["leq_5m"][lbl];
        ai.v5m = base["leq_5m"][lbl];
      }
    }
    else { // level is below limit, we could ease off any attenuation
      //console.log("band " + band + " under limit: " + base["leq_5m"][lbl] + ", limit = " + bandConfig.limit5m);
      if(ai.lastUpdate && (new Date().getTime()-ai.lastUpdate.getTime()) > bandConfig.minDecDelay && ai.level < 0) {
        ai.level = ai.level+1;
        if(ai.level > 0)ai.level = 0;
        ai.v5m = base["leq_5m"][lbl];
        ai.lastUpdate = new Date();
        console.log("reducing attn on band " + band + ": " + ai.level);
      }
    }
    if(oldLevel != ai.level) {
      console.log("attn of " + band + " changed from " + oldLevel + " to " + ai.level);
      updateEQ(band, ai.level);
    }
  } // end for-loop over all bands
  updAttn = false;
}

/**
 * Slope based approach: check slope of leq_5m value since last attn update
 * if slope is rising and over limit, increase attenuation
 * if slope is rising towards limit, ease it off by pulling down the respective EQ band some more
 * if slope is decreasing towards limit from above, decide whether it is quick enough to still meet the limit on 1h average
 * if slope is decreasing and 5m lower than limit, ease off attenuation
 */
async function updateAttenuation() {
  let algorithm = remoteConfig.algorithm;
  algorithm = algorithms[algorithm];
  if(!algorithm) {
    algorithm = attnNoop;
  }
  algorithm();
}

const algorithms = {"noop":attnNoop, "slope":attnSlopeBased};

async function attnNoop() {
  return;
}

async function attnSlopeBased() {
  if(updAttn) { console.log("update attn in progress, skipping");} // prevent multiple entry
  updAttn = true;
  let geqSetting = null;
  try {
    geqSetting = await dsp206.getGeqConfig(1); // InB, returns array of {bandId, frequency, level} structs
    //console.log("received current InB GEQ: " + JSON.stringify(geqSetting));
  }
  catch(e) {
    console.error("Error getting geq config: ", e);
    updAttn = false;
    return;
  }
  
  let base = JSON.parse(JSON.stringify(measBuffer.buf[measBuffer.idx])); // deep copy
  base.time = new Date(base.time);
  //console.log("update attn on record " + JSON.stringify(base)+ ", base.time = " + (typeof base.time) + ", top entry time: " + measBuffer.buf[measBuffer.idx].time);
  for(let i = 0; i < bands.length; i++) {
    let bandConfig = remoteConfig.bandConfig[bands[i]];
    if(!bandConfig) continue;
    let band = bands[i];
    let lbl = bandLabelMap[band];
    //console.log("updating attn for band " + band + ", lbl " + lbl);
    // is the 5m value over the limit
    let ai = attnInfo[band];
    let aiCurrentLevel = i>8?geqSetting[i-9].level:0;
    
    if(ai.lastUpdate) {
      if(new Date().getTime() - ai.lastUpdate.getTime() < Math.min(bandConfig.minIncDelay, bandConfig.minDecDelay)) {
        continue; // do nothing yet, wait for delay to elapse
      }
    }
    let oldLevel = ai.level;
    let current5mlevel = base["leq_5m"][lbl];
    let current10slevel = base["leq_10s"][lbl];
    let current1hlevel = base["leq_1h"][lbl];
    let slope = ai.lastUpdate?(current10slevel - oldLevel)/(base.time.getTime()-ai.lastUpdate.getTime()):0;
    let slopeFactor = 0.1;
    let maxAllowedSlope = (bandConfig.limit5m - current10slevel)*slopeFactor;
    /*if(bandConfig.limit1h < current1hlevel) {
      let mas1h = 0;
      maxAllowedSlope = Math.min(maxAllowedSlope, mas1h);
      console.log("limiting maxAllowedSlope of " + band + " by 1h limit");
    }*/
    console.log("slope " + band + " = " + slope + ", maxAllowedSlope = " + maxAllowedSlope + ", slope over time " + (ai.lastUpdate?base.time.getTime()-ai.lastUpdate.getTime():"no") + " ms");
    
    if(slope > maxAllowedSlope) { // we are already over limit in 5m
      // has it been attenuated before?
      //console.log("band " + band + " over limit: " + base["leq_5m"][lbl] + ", limit = " + bandConfig.limit5m);
      if(ai.lastUpdate && new Date().getTime() - ai.lastUpdate.getTime() < bandConfig.minIncDelay) {
        continue; // do nothing yet, wait for delay to elapse
      }
      if(oldLevel != aiCurrentLevel) {
        // skip update since we haven't seen effect of last update yet
        console.log("current geq level " + aiCurrentLevel + " of band " + band + " not set to target " + oldLevel + " yet, no further adjustment for now.");
      }
      else {
        // increase attenuation
        let attnDelta = 0.5; // 1 dB steps, regardless of slope
        if(current10slevel - bandConfig.limit5m > 2) {
          attnDelta = 1;
          console.log("setting attn delta to " + attnDelta + " due to 2 db excess peak");
        }
        else if(current10slevel - bandConfig.limit5m > 4) {
          attnDelta = 3;
          console.log("setting attn delta to " + attnDelta + " due to 4 db excess peak");
        }
        ai.level = oldLevel - attnDelta;
        if(ai.level < -12)ai.level = -12;
        ai.v5m = current5mlevel;
        ai.v10s = current10slevel;
        ai.lastUpdate = new Date();
      }
    }
    else { // slope is ok
      if(ai.lastUpdate && (new Date().getTime()-ai.lastUpdate.getTime()) > bandConfig.minDecDelay && ai.level < 0) {
        let attnDelta=0.5;
        ai.level = oldLevel + attnDelta;
        if(ai.level > 0)ai.level = 0;
        ai.v5m = current5mlevel;
        ai.v10s = current10slevel;
        ai.lastUpdate = new Date();
        console.log("reducing attn on band " + band + ": " + ai.level);
      }
    }
    if(aiCurrentLevel != ai.level) {
      console.log("attn of " + band + " is " + aiCurrentLevel + ", not matching current target " + ai.level);
      await updateEQ(band, ai.level);
    }
  } // end for-loop over all bands
  updAttn = false;
}

// need to be careful not queue too many updates here
async function updateEQ(band, level) {
  if(["A","B","C","D"].indexOf(band) > -1){
    console.log("ignoring updateEQ for band " + band + " because it isn't available in GEQ");
    return;
  }
  let frequency = parseFloat(band.replace(/Hz/g, "").replace(/k/g,"000"));
  if(dsp206) {
    try {
      await dsp206.setGeqLevel(1, frequency, level);
      console.log("updated geq of InB on band " + frequency + " to " + level + " dB");
    }
    catch(e) {
      console.log("GEQ update failed trying to set level " + level + " on band " + frequency + " Hz");
    }
  }
  else {
    console.log("no dsp206, skipping attenuation change");
  }
}


let timeSyncInterval = null;
let dsp206 = null;
let remoteConfig = {};

async function updateConfig() {
  try {
    let prevAlgo = remoteConfig.algorithm;
    let data = await download("remoteConfig.json");
    remoteConfig = JSON.parse(data.toString());
    console.log("updated config from remote: " + data.toString());
    if(prevAlgo != remoteConfig.algorithm) {
      console.log("new attenuation algorithm in remoteConfig update: " + remoteConfig.algorithm);
      for(let ai of Object.values(attnInfo)) {
        ai.level = 0;
      }
    }
    if(dsp206) {
      if(dsp206.deviceID != remoteConfig.dsp206Config.deviceID || dsp206.ipAddress != remoteConfig.dsp206Config.ipAddress) {
        console.log("config for dsp206 changed, tearing down instance...");
        try {
          dsp206.close();
          dsp206 = new Dsp206(remoteConfig.dsp206Config.deviceID, remoteConfig.dsp206Config.ipAddress);
          console.log("recreated dsp206 instance with new config");
        }
        catch(e) {
          console.error("error closing dsp206: ", e);
        }
      }
    }
    else {
      dsp206 = new Dsp206(remoteConfig.dsp206Config.deviceID, remoteConfig.dsp206Config.ipAddress);
      console.log("created new dsp206 instance");
    }
  }
  catch(e) {
    console.error(e);
    console.log("error updating remoteConfig: ", e);
  }
  if(new Date().getTime() - lastSerialData.getTime() > 10000) {
    // havent received any input from serial, probably disconnect or measurement stopped
    deviceState = 0;
    try {
      console.log("no new serial data since " + lastSerialData.toISOString() + ", restarting measurement...");
      await initSerialDevice();
      console.log("serial device initialized.");
      await restartMeasurement();
    }
    catch(e) {
      console.error("unable to stop /restart measurement: ", e);
    }
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
  return data;
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

async function startup() {

  try {
    await stopMeasurement();
    console.log("measurement not running");
  }
  catch(e) {
    console.log("measurement stop failed: ", e);
  }
  
 
  await initBuffer();

  await initSerialDevice();

  await initBlobClient();

  await updateConfig();
  setInterval(updateConfig, 1000*30); // alle 30 s


  await startMeasurement();
}

async function run() {
  let startupTime = new Date();
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

  
  while(true){
    console.log("checking for stale local files...");
    fs.readdir("buffer/", (err, files) => {
      if(err) {
        console.error("error listing buffer files on shutdown check: ", err);
      }
      else {
        for(let fn of files) {
          let timeStr = fn.replace(/\//g, "-");
          timeStr = timeStr.substring(0,10)+"T"+timeStr.substring(11,13)+":00:00.000Z";
          let fnDate = new Date(timeStr);
          console.log("checking file " + fn + " with timeStr " + timeStr + " -> Date " + fnDate);
          if(new Date().getTime() - fnDate.getTime() > 2*3600*1000) {
            console.log("file " + fn + " older than two hours, deleting...");
            fs.unlink("buffer/"+fn, (err) => {
              if(err) {
                console.error("failed to delete file " + fn + ": ", err);
              }
              else {
                console.log("successfully deleted " + fn);
              }
            });
          }
        }
      }
    });

    console.log("checking shutdown condition");
    await sleep(10*60*1000); // wait ten minutes
    if(new Date().getTime() - startupTime.getTime() > 23*3600*1000 && new Date().getUTCHours() == 10
       && uplink.status == "online" && new Date().getTime() - uplink.joinTime.getTime() < 5*60*1000) {
      // only if online and connected a few minutes can we be sure that we don't have local data not yet synced to cloud
      console.log("shutdown condition met: between 10 and 11 UTC and online for at least 5 minutes. shutting down...");
      await stopMeasurement();
      process.exit(0);
    }
  }
  
}

run();

//serialAMA.write("data from AMA serial\n");



