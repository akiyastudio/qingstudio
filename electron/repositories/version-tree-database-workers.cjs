const { PythonDatabaseClient } = require('./database-client.cjs');
const { createMediaRepository } = require('../domains/media/public.cjs');

const createVersionTreeDatabaseWorkers = ({
  coordinator,
  getRunConfig,
  getDatabasePath,
  writeLog,
  processSupervisor,
  databaseHealthOptions,
}) => {
  const createWorker = (processId, domainId, defaultTimeoutMs) => new PythonDatabaseClient({
    coordinator,
    getRunConfig,
    getDatabasePath,
    writeLog,
    processSupervisor,
    processId,
    ...databaseHealthOptions(domainId),
    defaultTimeoutMs,
  });
  const readDatabase = createWorker('python:version-read', 'version-read', 60 * 1000);
  const locationDatabase = createWorker('python:version-locations', 'version-locations', 2 * 60 * 1000);
  return {
    readDatabase,
    locationDatabase,
    readRepository: createMediaRepository(readDatabase),
    locationRepository: createMediaRepository(locationDatabase),
  };
};

module.exports = { createVersionTreeDatabaseWorkers };
