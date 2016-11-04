"use strict";

import * as express from "express";
import * as logger from "morgan";
import {Gateway} from "./gateway";
import * as fs from "fs-extra";
import * as winston from "winston";
import {Container} from "typescript-ioc";
import * as compression from "compression";
import {Parameters} from "./command-line";
import {APIService} from "./admin/admin-server";
import * as path from "path";
import {Server} from "typescript-rest";

let gateway: Gateway = Container.get(Gateway);
let app = configureGatewayServer();
module.exports = app;

configureAdminServer();

function configureGatewayServer() {
  let app = gateway.server;
  app.disable('x-powered-by'); 
  app.use(compression());
  //app.enable('trust proxy'); // If we are behind a reverse proxy (Heroku, Bluemix, AWS if you use an ELB, custom Nginx setup, etc) 


  if (app.get('env') == 'production') {
    const accessLogStream = fs.createWriteStream(path.join(Parameters.rootDir, 'logs/access_errors.log'),{flags: 'a'});
    app.use(logger('common', {
      skip: function(req: express.Request, res: express.Response) { 
          return res.statusCode < 400 
      }, 
      stream: accessLogStream }));
  } 
  else {
    app.use(logger('dev'));
  }
  gateway.initialize();
  app.listen(Parameters.port, ()=>{
    winston.info('Gateway listenning on port %d', Parameters.port);
  });

  return app;
}

function configureAdminServer() {
  let adminServer = express();
  adminServer.disable('x-powered-by'); 
  adminServer.use(compression());
  adminServer.use(logger('dev'));

  Server.buildServices(adminServer, APIService);
  adminServer.listen(Parameters.adminPort, ()=>{
    winston.info('Gateway Admin API listenning on port %d', Parameters.adminPort);
  });
  return adminServer;
}
