const fs = require('fs');
const path = require('path');

module.exports = async ({ win, p, app, ipcMain }) => {
  const dir = process.env.SPIKE_OUT;
  fs.mkdirSync(dir, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const shot = async (name) => {
    fs.writeFileSync(path.join(dir, name), (await win.webContents.capturePage()).toPNG());
  };
  const dump = (name) =>
    new Promise((resolve) => {
      ipcMain.once('spike:dump', (e, obj) => {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 1));
        resolve(obj);
      });
      win.webContents.send('spike:dump');
    });

  await sleep(25000);
  await shot('1-start.png');
  const a = await dump('1-start.json');
  if (a.lines.join('\n').includes('trust this folder')) {
    p.write('\x1b[B');
    await sleep(1000);
    p.write('\r');
    await sleep(25000);
  }

  await shot('2-ready.png');
  await dump('2-ready.json');
  p.write('What was the key I gave you? Reply with only it.');
  await sleep(1500);
  p.write('\r');
  await sleep(60000);
  await shot('3-reply.png');
  await dump('3-reply.json');
  p.kill();
  setTimeout(() => app.exit(0), 1000);
};
