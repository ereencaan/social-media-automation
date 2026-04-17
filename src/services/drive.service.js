const { google } = require('googleapis');
const path = require('path');
const { Readable } = require('stream');

let driveClient = null;

function getClient() {
  if (driveClient) return driveClient;

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    || path.join(__dirname, '../../config/google-service-account.json');

  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

async function ensureFolder(drive, folderName, parentId) {
  const query = [
    `name='${folderName}'`,
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    `'${parentId}' in parents`
  ];

  const res = await drive.files.list({
    q: query.join(' and '),
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  if (res.data.files.length > 0) return res.data.files[0].id;

  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id',
    supportsAllDrives: true
  });

  return folder.data.id;
}

async function uploadImage(imageBuffer, fileName) {
  const drive = getClient();

  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || '1v36Xsea0RPRrj1W9C7sgWjrYdwFRAOR0';
  const monthFolderId = await ensureFolder(drive, yearMonth, rootFolderId);

  const stream = new Readable();
  stream.push(imageBuffer);
  stream.push(null);

  const file = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [monthFolderId]
    },
    media: {
      mimeType: 'image/jpeg',
      body: stream
    },
    fields: 'id, webViewLink, webContentLink',
    supportsAllDrives: true
  });

  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true
  });

  const publicUrl = `https://drive.google.com/uc?export=view&id=${file.data.id}`;

  return {
    fileId: file.data.id,
    webViewLink: file.data.webViewLink,
    publicUrl
  };
}

module.exports = { uploadImage };
