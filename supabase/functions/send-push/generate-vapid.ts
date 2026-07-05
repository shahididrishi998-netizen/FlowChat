import * as webpush from "jsr:@negrel/webpush@0.5.0";

const keys = await webpush.generateVapidKeys({
  extractable: true,
});

const exported = await webpush.exportVapidKeys(keys);

console.log(JSON.stringify(exported.publicKey));
console.log(JSON.stringify(exported.privateKey));