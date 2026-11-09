const { app, BrowserWindow, ipcMain } = require('electron');
const pty = require('node-pty');
const fs = require('fs');
const path = require('path');

let win;
let p;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile('index.html');
}

ipcMain.once('pty:start', (e, cols, rows) => {
  const args = (process.env.SPIKE_CLAUDE_ARGS || '').split(' ').filter(Boolean);
  p = pty.spawn('cmd.exe', ['/c', 'claude', ...args], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.SPIKE_CWD || process.cwd(),
    env: process.env,
  });
  p.onData((data) => {
    if (win) win.webContents.send('pty:data', data);
  });
  p.onExit(({ exitCode }) => {
    console.log('pty exit code:', exitCode);
  });

  if (process.env.SPIKE_SCRIPT) {
    require(require('path').resolve(process.env.SPIKE_SCRIPT))({ win, p, app, ipcMain });
  } else if (process.env.SPIKE_SHOTS) {
    runShots(process.env.SPIKE_SHOTS).catch((err) => {
      console.error(err);
      app.quit();
    });
  }
});

ipcMain.on('pty:input', (e, d) => {
  if (p) p.write(d);
});

ipcMain.on('pty:resize', (e, cols, rows) => {
  if (p) p.resize(cols, rows);
});

async function runShots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const save = async (name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name), image.toPNG());
  };

  await sleep(25000);
  await save('1-start.png');

  for (let i = 1; i <= 60; i++) {
    win.setSize(Math.round(1000 - (400 * i) / 60), 700);
    await sleep(16);
  }
  for (let i = 1; i <= 30; i++) {
    win.setSize(Math.round(600 + (200 * i) / 30), 700);
    await sleep(16);
  }

  await sleep(3000);
  await save('2-after-drag.png');

  for (let i = 0; i < 5; i++) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 480, wheelTicksX: 0, wheelTicksY: 4, canScroll: true }); await sleep(100); }
  await sleep(1000);
  await save('3-scrolled.png');

  win.webContents.send('spike:scroll', 100000);
  await sleep(500);
  win.webContents.send('spike:dump');

  ipcMain.once('spike:dump', (e, obj) => {
    fs.writeFileSync(path.join(dir, 'dump.json'), JSON.stringify(obj, null, 1));
    if (p) p.kill();
    setTimeout(() => app.exit(0), 1000);
  });
}

app.on('window-all-closed', () => {
  if (p) p.kill();
  app.quit();
});

app.whenReady().then(createWindow);
