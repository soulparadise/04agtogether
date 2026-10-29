const { createApplication } = require('./server.cjs');

async function startDevelopmentBackend({ port = 3000 } = {}) {
  // Only this prototype's stable extension origin, and only in local development.
  const { id } = require('../extension/identity.json');
  const application = createApplication({ developmentDiagnostics: true, extensionOrigins: [`chrome-extension://${id}`] });
  await new Promise((resolve, reject) => {
    application.server.once('error', reject);
    application.server.listen(port, '127.0.0.1', () => {
      application.server.removeListener('error', reject);
      resolve();
    });
  });
  console.log('Backend: http://127.0.0.1:' + application.server.address().port);
  return application;
}

if (require.main === module) {
  startDevelopmentBackend().then(({ io }) => {
    const stop = () => io.close(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { startDevelopmentBackend };
