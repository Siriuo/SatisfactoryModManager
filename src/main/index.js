import {
  app, BrowserWindow, ipcMain, shell,
} from 'electron';
import path from 'path';
import { autoUpdater } from 'electron-updater';
import WebSocket from 'ws';
import { getSetting, saveSetting } from '../renderer/settings';

process.env.SMM_API_USERAGENT = process.env.NODE_ENV !== 'development' ? app.name : 'SMM-dev';
process.env.SMM_API_USERAGENT_VERSION = process.env.NODE_ENV !== 'development' ? app.getVersion() : 'development';

/**
 * Set `__static` path to static files in production
 * https://simulatedgreg.gitbooks.io/electron-vue/content/en/using-static-assets.html
 */
if (process.env.NODE_ENV !== 'development') {
  global.__static = path.join(__dirname, '/static').replace(/\\/g, '\\\\');
}

app.allowRendererProcessReuse = false;

/** @type { BrowserWindow } */
let mainWindow;
const mainURL = 'http://localhost:9080';
const mainFile = path.resolve(__dirname, 'index.html');

function sendToWindow(channel, ...args) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function openedByUrl(url) {
  if (url) {
    sendToWindow('openedByUrl', url);
  }
}

const normalSize = getSetting('normalSize', {
  width: 500,
  height: 858,
});
const minNormalSize = {
  width: 500,
  height: 725,
};
const expandedSize = getSetting('expandedSize', {
  width: 1575,
  height: 858,
});
const minExpandedSize = {
  width: 1200,
  height: 725,
};

let isExpanded = false;
let isChangingExpanded = false;

function updateSize() {
  const size = isExpanded ? expandedSize : normalSize;
  const minSize = isExpanded ? minExpandedSize : minNormalSize;
  mainWindow.setMinimumSize(minSize.width, minSize.height); // https://github.com/electron/electron/issues/15560#issuecomment-451395078
  mainWindow.setMaximumSize(isExpanded ? 2147483647 : normalSize.width, 2147483647);
  mainWindow.setSize(size.width, size.height, true);
}

function createWindow() {
  /**
   * Initial window options
   */
  mainWindow = new BrowserWindow({
    width: normalSize.width,
    height: normalSize.height,
    minHeight: minNormalSize.height,
    minWidth: minNormalSize.width,
    maxWidth: normalSize.width,
    useContentSize: true,
    webPreferences: {
      nodeIntegration: true,
    },
    frame: false,
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL(mainURL);
  } else {
    mainWindow.loadFile(mainFile);
  }

  mainWindow.on('resize', () => {
    if (!isChangingExpanded) {
      normalSize.height = mainWindow.getBounds().height;
      expandedSize.height = mainWindow.getBounds().height;
      if (isExpanded) {
        expandedSize.width = mainWindow.getBounds().width;
      }
      saveSetting('normalSize', normalSize);
      saveSetting('expandedSize', expandedSize);
    }
  });

  ipcMain.on('openDevTools', () => {
    mainWindow.webContents.openDevTools();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('new-window', (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });
}

let isDownloadingUpdate = false;
let quitWaitingForUpdate = false;
let hasUpdate = false;

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', (e, argv) => {
    if (process.platform === 'win32') {
      openedByUrl(argv.find((arg) => arg.startsWith('smmanager:')));
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      if (hasUpdate) {
        if (!isDownloadingUpdate) {
          autoUpdater.quitAndInstall(false);
        } else {
          quitWaitingForUpdate = true;
        }
      } else {
        app.quit();
      }
    }
  });

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    }
  });

  ipcMain.once('vue-ready', () => {
    if (process.platform === 'win32') {
      openedByUrl(process.argv.find((arg) => arg.startsWith('smmanager:')));
    }
  });

  ipcMain.on('expand', () => {
    isChangingExpanded = true;
    isExpanded = true;
    updateSize();
    isChangingExpanded = false;
  });

  ipcMain.on('unexpand', () => {
    isChangingExpanded = true;
    isExpanded = false;
    updateSize();
    isChangingExpanded = false;
  });

  autoUpdater.fullChangelog = true;

  autoUpdater.on('update-downloaded', () => {
    sendToWindow('updateDownloaded');
    if (quitWaitingForUpdate) {
      autoUpdater.quitAndInstall(false);
    } else {
      isDownloadingUpdate = false;
    }
  });

  autoUpdater.on('download-progress', (info) => {
    // TODO: this doesn't fire for differential downloads https://github.com/electron-userland/electron-builder/issues/2521
    sendToWindow('updateDownloadProgress', info);
  });

  autoUpdater.on('error', () => {
    sendToWindow('updateNotAvailable');
    if (quitWaitingForUpdate) {
      app.quit();
    }
  });

  ipcMain.on('checkForUpdates', () => {
    autoUpdater.checkForUpdates();
  });

  autoUpdater.on('update-not-available', () => {
    sendToWindow('updateNotAvailable');
  });

  autoUpdater.on('update-available', (updateInfo) => {
    sendToWindow('updateAvailable', updateInfo);
    isDownloadingUpdate = true;
    hasUpdate = true;
  });

  app.on('ready', () => {
    if (process.env.NODE_ENV === 'production') {
      autoUpdater.checkForUpdates();
    }
  });

  if (!app.isDefaultProtocolClient('smmanager')) {
    app.setAsDefaultProtocolClient('smmanager');
  }

  app.on('will-finish-launching', () => {
    app.on('open-url', (event, url) => {
      event.preventDefault();
      openedByUrl(url);
    });
  });

  const wss = new WebSocket.Server({ port: 33642 });
  wss.on('connection', (ws) => {
    ws.on('message', (message) => {
      console.log('received: %s', message);
    });
  });
} else {
  app.quit();
}
