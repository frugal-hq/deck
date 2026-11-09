const fs = require('fs');
const path = require('path');

module.exports = async ({ win, p, app, ipcMain }) => {
  const dir = process.env.SPIKE_OUT;
  fs.mkdirSync(dir, { recursive: true });
  const fx = process.env.SPIKE_FIXTURES;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name), img.toPNG());
  };
  const paste = (s) => win.webContents.send('spike:paste', s);
  const type = (s) => p.write(s);
  const dump = (name) =>
    new Promise((resolve) => {
      ipcMain.once('spike:dump', (e, obj) => {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 1));
        resolve();
      });
      win.webContents.send('spike:dump');
    });

  const noSpace = path.join(fx, 'uno.png');
  const spaced = path.join(fx, 'con espacios');

  await sleep(20000);
  await shot('1-start.png');

  const steps = [
    () => type('UNO '),
    () => paste(noSpace),
    () => type(' DOS '),
    () => paste(path.join(spaced, 'foto dos.png')),
    () => type(' TRES '),
    () => paste('"' + path.join(spaced, 'foto tres.png') + '"'),
    () => type(' CUATRO '),
    () => paste('@' + path.join(spaced, 'nota a.txt')),
    () => type(' CINCO '),
    () => paste('@"' + path.join(spaced, 'nota b.txt') + '"'),
    () => type(' SEIS. Responde solo: ok'),
  ];
  for (const step of steps) {
    step();
    await sleep(1500);
  }

  await sleep(1500);
  await shot('2-prompt.png');
  await dump('2-prompt.json');
  p.write('\r');
  await sleep(45000);
  await shot('3-reply.png');
  await dump('3-reply.json');
  p.kill();
  setTimeout(() => app.exit(0), 1000);
};
