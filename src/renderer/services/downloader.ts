/* eslint-disable no-await-in-loop */
/* eslint-disable no-underscore-dangle */
import React from 'react';
const fs = require('fs');
const { ipcRenderer } = require('electron');
import { Chapter, PageRequesterData, Series } from '@tiyo/common';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { showNotification, updateNotification } from '@mantine/notifications';
import { IconCheck, IconPlayerPause } from '@tabler/icons';
import ipcChannels from '@/common/constants/ipcChannels.json';
import { GeneralSetting } from '@/common/models/types';
import persistantStore from '@/renderer/util/persistantStore';
import storeKeys from '@/common/constants/storeKeys.json';

export type DownloadTask = {
  chapter: Chapter;
  series: Series;
  page?: number;
  totalPages?: number;
  downloadsDir: string;
};

export type DownloadError = {
  chapter: Chapter;
  series: Series;
  errorStr: string;
};

const showDownloadNotification = (
  notificationId: string,
  task: DownloadTask | null,
  queueSize?: number,
) => {
  if (!task) return;

  const queueStr = queueSize && queueSize > 0 ? ` (${queueSize} downloads queued)` : '';
  updateNotification({
    id: notificationId,
    title: `Downloading ${task.series.title} chapter ${task.chapter.chapterNumber}`,
    message: `Page ${task.page || 0}/${task.totalPages || '??'}${queueStr}`,
    loading: true,
    autoClose: false,
  });
};

class DownloaderClient {
  setRunningState?: (running: boolean) => void;

  setQueueState?: (queue: DownloadTask[]) => void;

  setCurrentTaskState?: (currentTask: DownloadTask | null) => void;

  setDownloadErrorsState?: (downloadErrors: DownloadError[]) => void;

  running = false;

  queue: DownloadTask[] = [];

  currentTask: DownloadTask | null = null;

  downloadErrors: DownloadError[] = [];

  setStateFunctions = (
    setRunningState: (running: boolean) => void,
    setQueueState: (queue: DownloadTask[]) => void,
    setCurrentTaskState: (currentTask: DownloadTask | null) => void,
    setDownloadErrorsState: (downloadErrors: DownloadError[]) => void,
  ) => {
    this.setRunningState = setRunningState;
    this.setQueueState = setQueueState;
    this.setCurrentTaskState = setCurrentTaskState;
    this.setDownloadErrorsState = setDownloadErrorsState;
  };

  setRunning = (running: boolean) => {
    this.running = running;
    if (this.setRunningState) this.setRunningState(running);
  };

  setQueue = (queue: DownloadTask[]) => {
    this.queue = queue;
    if (this.setQueueState) this.setQueueState(queue);
  };

  setCurrentTask = (currentTask: DownloadTask | null) => {
    this.currentTask = currentTask;
    if (this.setCurrentTaskState) this.setCurrentTaskState(currentTask);
  };

  setDownloadErrors = (downloadErrors: DownloadError[]) => {
    this.downloadErrors = downloadErrors;
    if (this.setDownloadErrorsState) this.setDownloadErrorsState(downloadErrors);
  };

  _handleDownloadError = (downloadError: DownloadError) => {
    console.error(downloadError.errorStr);
    this.setRunning(false);
    this.setCurrentTask(null);
    this.setDownloadErrors([...this.downloadErrors, downloadError]);
  };

  _convertToCBZ = async (chapterPath: string) => {
    await new Promise((resolve) => {
      const cbzFile = new JSZip();

      const files = fs.readdirSync(chapterPath);
      files.sort().forEach((file: string) => {
        cbzFile.file(file, fs.createReadStream(`${chapterPath}\\${file}`));
      });

      const folderParts = chapterPath.split('\\');
      const fileName = folderParts.pop();
      const folderPath = folderParts.join('\\');

      cbzFile
        .generateNodeStream({ type: 'nodebuffer', streamFiles: true })
        .pipe(fs.createWriteStream(`${folderPath}\\${fileName}.cbz`, { flags: 'w' }))
        .on('finish', resolve);
    });

    fs.rmSync(chapterPath, { recursive: true, force: true });
  };

  start = async () => {
    if (this.running) return;

    if (this.queue.length === 0) {
      this.setRunning(false);
      return;
    }

    const startingQueueSize = this.queue.length;
    const notificationId = uuidv4();
    showNotification({ id: notificationId, message: 'Starting download...', loading: true });

    this.setRunning(true);
    let tasksCompleted = 0;
    while (this.running && this.queue.length > 0) {
      const task: DownloadTask | undefined = this.queue[0];
      this.setQueue(this.queue.slice(1));
      if (task === undefined) {
        break;
      }

      this.setCurrentTask(task);
      showDownloadNotification(notificationId, this.currentTask, this.queue.length);

      // eslint-disable-next-line no-await-in-loop
      const chapterPath = await ipcRenderer.invoke(
        ipcChannels.FILESYSTEM.GET_CHAPTER_DOWNLOAD_PATH,
        task.series,
        task.chapter,
        task.downloadsDir,
      );
      // fix issue where if you saved a chapter in cbz before and redownload chapter it breaks app
      // tries to save 01.png to ./title/chapter.cbz/01.png
      if (!fs.existsSync(chapterPath)) {
        fs.mkdirSync(chapterPath, { recursive: true });
      }

      // eslint-disable-next-line no-await-in-loop
      const pageUrls: string[] = await ipcRenderer
        .invoke(
          ipcChannels.EXTENSION.GET_PAGE_REQUESTER_DATA,
          task.series.extensionId,
          task.series.sourceId,
          task.chapter.sourceId,
        )
        .then((pageRequesterData: PageRequesterData) =>
          ipcRenderer.invoke(
            ipcChannels.EXTENSION.GET_PAGE_URLS,
            task.series.extensionId,
            pageRequesterData,
          ),
        );

      if (
        !pageUrls.every(
          (pageUrl: string) => pageUrl.startsWith('http://') || pageUrl.startsWith('https://'),
        )
      ) {
        this._handleDownloadError({
          chapter: task.chapter,
          series: task.series,
          errorStr: `Chapter contains invalid page URL(s) that cannot be downloaded`,
        } as DownloadError);
        break;
      }

      console.debug(`Downloading pages for chapter ${task.chapter.id} of series ${task.series.id}`);

      const startPage = task.page === undefined ? 1 : task.page;
      console.debug(`Starting download at page ${startPage}`);

      let i = startPage;
      for (i; i <= pageUrls.length && this.running; i += 1) {
        const pageUrl = pageUrls[i - 1];
        const extMatch = pageUrl.match(/\.(gif|jpe?g|tiff?|png|webp|bmp)$/i);
        const ext = extMatch ? extMatch[1] : 'jpg';
        const pageNumPadded = String(i).padStart(pageUrls.length.toString().length, '0');
        const pagePath = path.join(chapterPath, `${pageNumPadded}.${ext}`);

        const arrayBuffer: ArrayBuffer = await ipcRenderer
          .invoke(ipcChannels.EXTENSION.GET_IMAGE, task.series.extensionId, task.series, pageUrl)
          .then(async (data) => {
            if (typeof data === 'string') {
              // eslint-disable-next-line promise/no-nesting
              return fetch(pageUrl).then(async (response) => response.arrayBuffer());
            }
            return data;
          });

        fs.writeFileSync(pagePath, Buffer.from(arrayBuffer));
        this.setCurrentTask({
          series: task.series,
          chapter: task.chapter,
          downloadsDir: task.downloadsDir,
          page: i,
          totalPages: pageUrls.length,
        });
        showDownloadNotification(notificationId, this.currentTask, this.queue.length);
      }

      if (!this.running) {
        // task was paused, add it back to the start of the queue
        this.setQueue([{ ...task, page: i, totalPages: pageUrls.length }, ...this.queue]);
      } else {
        const saveDownloadAsCBZ = persistantStore.read(
          storeKeys.SETTINGS.GENERAL_PREFIX + GeneralSetting.SaveDownloadAsCBZ,
        );

        if (saveDownloadAsCBZ === 'true') await this._convertToCBZ(chapterPath);

        tasksCompleted += 1;
      }
    }

    if (this.running) {
      updateNotification({
        id: notificationId,
        title: `Downloaded ${this.currentTask?.series.title} chapter ${this.currentTask?.chapter.chapterNumber}`,
        message: startingQueueSize > 1 ? `Downloaded ${tasksCompleted} chapters` : '',
        color: 'teal',
        icon: React.createElement(IconCheck, { size: 16 }),
        loading: false,
        autoClose: true,
      });
    } else {
      updateNotification({
        id: notificationId,
        title: `Download paused`,
        message: startingQueueSize > 1 ? `Finished ${tasksCompleted} downloads` : '',
        color: 'yellow',
        icon: React.createElement(IconPlayerPause, { size: 16 }),
        loading: false,
        autoClose: true,
      });
    }

    this.setRunning(false);
    this.setCurrentTask(null);
  };

  pause = () => {
    this.setRunning(false);
  };

  add = (tasks: DownloadTask[]) => {
    const filteredTasks = tasks.filter(
      (task) => !this.queue.some((existingTask) => existingTask.chapter.id === task.chapter.id),
    );

    this.setQueue([...this.queue, ...filteredTasks]);
  };

  clear = () => {
    this.setQueue([]);
  };
}

export const downloaderClient = new DownloaderClient();
