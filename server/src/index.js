require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const http = require('http');
const path = require('path');

const apiRoutes = require('./routes/api');
const { setupWebSocketServer } = require('./wsHub');

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // relaxed CSP so the dashboard's inline WS/canvas code works
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', apiRoutes);

const server = http.createServer(app);
setupWebSocketServer(server);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`MDM server listening on :${PORT}`);
});
