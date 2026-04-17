const cloudinary = require('cloudinary').v2;

let configured = false;

function configure() {
  if (configured) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
  configured = true;
}

async function uploadImage(imageBuffer, fileName) {
  configure();

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'social-media-automation',
        public_id: fileName.replace(/\.[^.]+$/, ''),
        resource_type: 'image'
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          publicUrl: result.secure_url,
          fileId: result.public_id
        });
      }
    );
    stream.end(imageBuffer);
  });
}

async function uploadVideo(videoBuffer, fileName) {
  configure();

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'social-media-automation',
        public_id: fileName.replace(/\.[^.]+$/, ''),
        resource_type: 'video'
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          publicUrl: result.secure_url,
          fileId: result.public_id
        });
      }
    );
    stream.end(videoBuffer);
  });
}

async function uploadFromUrl(url, options = {}) {
  configure();

  const resourceType = options.isVideo ? 'video' : 'image';
  const result = await cloudinary.uploader.upload(url, {
    folder: 'social-media-automation',
    resource_type: resourceType,
    ...(options.publicId && { public_id: options.publicId })
  });

  return {
    publicUrl: result.secure_url,
    fileId: result.public_id
  };
}

module.exports = { uploadImage, uploadVideo, uploadFromUrl };
