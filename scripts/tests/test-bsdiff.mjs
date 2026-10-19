import fs from 'node:fs';
import { bsdiff } from '../bsdiff.mjs';
import zlib from 'node:zlib';

function bspatchSync(patch, old) {
  if (patch.toString('latin1', 0, 8) !== 'GBDIFF10') throw new Error('bad magic');
  let off = 8;
  const newSize = patch.readUInt32LE(off); off += 4;
  const ctrlLen = patch.readUInt32LE(off); off += 4;
  const diffLen = patch.readUInt32LE(off); off += 4;
  const extraLen = patch.readUInt32LE(off); off += 4;
  const ctrl = patch.subarray(off, off + ctrlLen); off += ctrlLen;
  const diff = zlib.inflateSync(patch.subarray(off, off + diffLen)); off += diffLen;
  const extra = zlib.inflateSync(patch.subarray(off, off + extraLen)); off += extraLen;
  const out = Buffer.alloc(newSize);
  let oldPos=0,newPos=0,ctrlPos=0,diffPos=0,extraPos=0;
  const readCtrl=()=>{const x=ctrl.readInt32LE(ctrlPos);ctrlPos+=4;const y=ctrl.readInt32LE(ctrlPos);ctrlPos+=4;const z=ctrl.readInt32LE(ctrlPos);ctrlPos+=4;return[x,y,z];};
  while(newPos<newSize){
    const [x,y,z]=readCtrl();
    for(let i=0;i<x;i++){out[newPos]=((old[oldPos]||0)+diff[diffPos])&0xff;newPos++;oldPos++;diffPos++;}
    extra.copy(out,newPos,extraPos,extraPos+y);newPos+=y;extraPos+=y;
    oldPos+=z;
  }
  return out;
}

let failures = 0;
function check(name, oldBuf, newBuf) {
  const patch = bsdiff(oldBuf, newBuf);
  const restored = bspatchSync(patch, oldBuf);
  const ok = restored.equals(newBuf);
  if (!ok) failures++;
  console.log(`${ok?'PASS':'FAIL'}  ${name}  old=${oldBuf.length} new=${newBuf.length} patch=${patch.length} ratio=${(patch.length/newBuf.length*100).toFixed(1)}%`);
}

check('identical', Buffer.from('hello world this is a test'), Buffer.from('hello world this is a test'));
check('small-edit', Buffer.from('hello world this is a test'), Buffer.from('hello world this is a TEST'));
check('insert', Buffer.from('abcdefghij'), Buffer.from('abcXXXdefghij'));
check('empty-old', Buffer.alloc(0), Buffer.from('brand new content'));
const oldBin = Buffer.alloc(5000); for(let i=0;i<5000;i++) oldBin[i]=Math.floor(Math.random()*256);
const newBin = Buffer.from(oldBin); newBin[1000]=0; newBin[2000]=255; newBin[3000]^=0xff;
check('binary', oldBin, newBin);
check('append', Buffer.from('short'), Buffer.from('short with a longer tail appended'));
// 大文件性能/正确性（1MB，90% 相同）
const bigOld = Buffer.alloc(1024*1024); for(let i=0;i<bigOld.length;i++) bigOld[i]=(i*31)%256;
const bigNew = Buffer.from(bigOld);
for(let i=1000;i<bigNew.length;i+=7777) bigNew[i]=(bigNew[i]+1)%256;
const t0 = Date.now();
check('large-1MB', bigOld, bigNew);
console.log(`large-1MB 耗时 ${Date.now()-t0}ms`);

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
