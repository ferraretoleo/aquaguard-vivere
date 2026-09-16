require('dotenv').config();
const { initializeDatabase } = require('../server-core');

initializeDatabase()
  .then(() => {
    console.log('Banco inicializado com sucesso.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Falha ao inicializar o banco:', error);
    process.exit(1);
  });
