import * as express from "express";
import * as request from "request";
import * as fs from "fs-extra-promise";
import "jasmine";
import {Gateway} from "../lib/gateway";
import * as path from "path";
import * as dbConfig from "../lib/redis";

let server;
let gateway: Gateway;
let gatewayRequest;
let adminRequest;

describe("Gateway Tests", () => {
	beforeAll(function(done){
		gateway = new Gateway("./tree-gateway-test.json");
        clearConfig()
        .then(()=>{
            return gateway.start();
        })
        .then(()=>{
            return gateway.startAdmin();
        })
        .then(() => {
            gateway.server.set('env', 'test');
            gatewayRequest = request.defaults({baseUrl: `http://localhost:${gateway.config.listenPort}`});
            adminRequest = request.defaults({baseUrl: `http://localhost:${gateway.config.adminPort}`});

            return gateway.redisClient.flushdb();
        })
        .then(()=>{
			return installMiddlewares();
		})
        .then(()=>{
			return installApis();
		})
		.then(done)
		.catch(fail);
	});

	afterAll(function(done){
		uninstallMiddlewares()
		.then(()=>{
			gateway.stopAdmin();
			gateway.stop();
			gateway.redisClient.disconnect();
		}).catch(fail);
	});

	describe("The Gateway Proxy", () => {
		it("should be able to proxy an API", (done) => {
			gatewayRequest("/test/get?arg=1", (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				expect(body).toBeDefined();
				let result = JSON.parse(body);
				expect(result.args.arg).toEqual("1");
				done();				
			});
		});
		it("should be able to filter requests by method", (done) => {
			gatewayRequest("/test/post", (error, response, body)=>{
				expect(response.statusCode).toEqual(405);
				done();				
			});
		});
		it("should be able to filter requests by path", (done) => {
			gatewayRequest("/test/user-agent", (error, response, body)=>{
				expect(response.statusCode).toEqual(404);
				done();				
			});
		});
		it("should be able to filter requests with custom filters", (done) => {
			gatewayRequest("/filtered/get", (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				gatewayRequest("/filtered/user-agent", (error, response, body)=>{
					expect(response.statusCode).toEqual(404);
					gatewayRequest("/filtered/get?denyParam=1", (error, response, body)=>{
						expect(response.statusCode).toEqual(404);
						done();				
					});
				});
			});
		});
		it("should be able to intercept requests ", (done) => {
			gatewayRequest("/intercepted/get", (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				let result = JSON.parse(body);
				expect(result.headers['X-Proxied-By']).toEqual("Tree-Gateway");
				expect(result.headers['X-Proxied-2-By']).toEqual("Tree-Gateway");
				done();				
			});
		});
		it("should be able to intercept requests with applies filter", (done) => {
			gatewayRequest("/intercepted/headers", (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				let result = JSON.parse(body);
				expect(result.headers['X-Proxied-2-By']).toEqual("Tree-Gateway");
				done();				
			});
		});
		it("should be able to intercept responses ", (done) => {
			gatewayRequest("/intercepted/get", (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				let result = JSON.parse(body);
				expect(response.headers['via']).toEqual("previous Interceptor wrote: Changed By Tree-Gateway, 1.1 Tree-Gateway");
				done();				
			});
		});
		it("should be able to intercept responses with applies filter", (done) => {
			gatewayRequest("/intercepted/headers", (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				let result = JSON.parse(body);
				expect(response.headers['via']).toEqual("Changed By Tree-Gateway, 1.1 Tree-Gateway");
				done();				
			});
		});
	});

	describe("The Gateway Limit Controller", () => {
		it("should be able to limit the requests to API", (done) => {
			gatewayRequest("/limited/get?arg=1", (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				let result = JSON.parse(body);
				expect(result.args.arg).toEqual("1");
				gatewayRequest("/limited/get?arg=1", (error, response, body)=>{
					expect(response.statusCode).toEqual(429);
					expect(body).toEqual("Too many requests, please try again later.");
					done();				
				});
			});
		});
		it("should be able to restict the limit to an API Group", (done) => {
			gatewayRequest("/limited-by-group/get?arg=1", (error, response, body)=>{
				let result = JSON.parse(body);
				expect(result.args.arg).toEqual("1");
				gatewayRequest("/limited-by-group/get?arg=1", (error, response, body)=>{
					expect(response.statusCode).toEqual(429);
					expect(body).toEqual("Too many requests, please try again later.");
					done();				
				});
			});
		});
		it("should be able to restict the limit to an API Group", (done) => {
			gatewayRequest("/limited-by-group/headers", (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				gatewayRequest("/limited-by-group/headers", (error, response, body)=>{
					expect(response.statusCode).toEqual(200);
					done();				
				});
			});
		});
	});

	describe("The Gateway Authenticator", () => {
		it("should be able deny request without authentication", (done) => {
			gatewayRequest("/secure/get?arg=1", (error, response, body)=>{
				expect(response.statusCode).toEqual(401);
				done();				
			});
		});

		it("should be able to verify JWT authentication on requests to API", (done) => {
			gatewayRequest.get({
				headers: { 'authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWV9.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ' },
				url:"/secure/get?arg=1"
			}, (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				let result = JSON.parse(body);
				expect(result.args.arg).toEqual("1");
				done();				
			});
		});

		it("should be able to verify JWT authentication on requests to API via query param", (done) => {
			gatewayRequest.get({
				url:"/secure/get?jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWV9.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ"
			}, (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				let result = JSON.parse(body);
				expect(result.args.jwt).toBeDefined();
				done();				
			});
		});

		it("should be able to verify Basic authentication on requests to API", (done) => {
			gatewayRequest.get({
				headers: { 'authorization': 'Basic dGVzdDp0ZXN0MTIz' },
				url:"/secureBasic/get?arg=1"
			}, (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				let result = JSON.parse(body);
				expect(result.args.arg).toEqual("1");
				done();				
			});
		});
		
		it("should be able to verify authentication only to restricted groups in API", (done) => {
			gatewayRequest.get({
				url:"/secureBasic-by-group/get?arg=1"
			}, (error, response, body)=>{
				expect(response.statusCode).toEqual(401);
				done();				
			});
		});

		it("should be able to verify authentication only to restricted groups in API", (done) => {
			gatewayRequest.get({
				url:"/secureBasic-by-group/headers"
			}, (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				done();				
			});
		});

		it("should be able to verify Local authentication on requests to API", (done) => {
			gatewayRequest.get({
				url:"/secureLocal/get?userid=test&passwd=test123"
			}, (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				let result = JSON.parse(body);
				expect(result.args.userid).toEqual("test");
				done();				
			});
		});

		it("should be able to verify a custom authentication on requests to API", (done) => {
			gatewayRequest.get({
				url:"/secureCustom/get?jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiYWRtaW4iOnRydWV9.TJVA95OrM7E2cBab30RMHrHDcEfxjoYZgeFONFh7HgQ"
			}, (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				let result = JSON.parse(body);
				expect(result.args.jwt).toBeDefined();
				done();				
			});
		});
	});
	
	describe("The Gateway Cache", () => {
		it("should be able to cache request on client", (done) => {
			gatewayRequest("/testCache/get", (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				expect(response.headers['cache-control']).toEqual("public,max-age=60");
				done();				
			});
		});

		it("should be able to preserve headers on requests from server cache", (done) => {
			gatewayRequest("/testCache/get", (error, response, body)=>{
				expect(response.statusCode).toEqual(200);
				expect(response.headers['access-control-allow-credentials']).toEqual("true");
				done();				
			});
		});
	});
	function installApis():Promise<void>{
         return new Promise<void>((resolve, reject)=>{
		    let pathApi = './src/spec/test-data/apis/';
            fs.readdirAsync(pathApi)
            .then(files=>{
                let promises = files.map(file => {return fs.readJsonAsync(pathApi+file)})
                return Promise.all(promises);
            }).then(files=>{
                let returned = 0, expected = files.length;;
                if (expected == 0) {
                    resolve();
                }
                files.forEach(apiConfig=>{
                    adminRequest.post("/apis", {body: apiConfig, json: true}, (error, response, body) => {
                        expect(error).toBeNull();
                        expect(response.statusCode).toEqual(201);
                        returned++;
                        if (returned == expected) {
                            resolve();
                        }
                    });
                })
            }).catch(reject);    
		});
	}

	function installMiddleware(fileName: string, servicePath: string, dir: string): Promise<void> {
		return new Promise<void>((resolve, reject)=>{
		    let pathMiddleware = './src/spec/test-data/middleware/';
			let filePath = path.join(pathMiddleware, dir, fileName+'.js');

			let req = adminRequest.post('/middleware'+servicePath, (error, response, body) => {
				if (error) {
					return reject(error);
				}
				if (response.statusCode == 201){
					return resolve();
				}
				return reject(`Status code: ${response.statusCode}`);
			});
			let form: FormData = req.form();
			form.append('name', fileName);
			form.append('file', fs.createReadStream(filePath), fileName+'.js');
		});
	}

	function uninstallMiddleware(fileName: string, servicePath: string): Promise<void> {
		return new Promise<void>((resolve, reject)=>{
			let req = adminRequest.delete('/middleware'+servicePath+fileName, (error, response, body) => {
				if (error) {
					return reject(error);
				}
				if (response.statusCode == 204){
					return resolve();
				}
				return reject(`Status code: ${response.statusCode}`);
			});
		});
	}

	function installMiddlewares():Promise<void>{
         return new Promise<void>((resolve, reject)=>{
			 installMiddleware('myJwtStrategy', '/authentication/strategies/', '/authentication/strategies')
			 .then(()=>{
				 return installMiddleware('verifyBasicUser', '/authentication/verify/', '/authentication/verify')
			 })
			 .then(()=>{
				 return installMiddleware('verifyJwtUser', '/authentication/verify/', '/authentication/verify')
			 })
			 .then(()=>{
				 return installMiddleware('myCustomFilter', '/filters', '/filter')
			 })
			 .then(()=>{
				 return installMiddleware('mySecondFilter', '/filters', '/filter')
			 })
			 .then(()=>{
				 return installMiddleware('myRequestInterceptor', '/interceptors/request', '/interceptor/request')
			 })
			 .then(()=>{
				 return installMiddleware('mySecondRequestInterceptor', '/interceptors/request', '/interceptor/request')
			 })
			 .then(()=>{
				 return installMiddleware('myResponseInterceptor', '/interceptors/response', '/interceptor/response')
			 })
			 .then(()=>{
				 return installMiddleware('SecondInterceptor', '/interceptors/response', '/interceptor/response')
			 })
			 .then(resolve)
			 .catch(reject);
		});
	}

	function uninstallMiddlewares():Promise<void>{
         return new Promise<void>((resolve, reject)=>{
			 uninstallMiddleware('myJwtStrategy', '/authentication/strategies/')
			 .then(()=>{
				 return uninstallMiddleware('verifyBasicUser', '/authentication/verify/')
			 })
			 .then(()=>{
				 return uninstallMiddleware('verifyJwtUser', '/authentication/verify/')
			 })
			 .then(()=>{
				 return uninstallMiddleware('myCustomFilter', '/filters')
			 })
			 .then(()=>{
				 return uninstallMiddleware('mySecondFilter', '/filters')
			 })
			 .then(()=>{
				 return uninstallMiddleware('myRequestInterceptor', 'interceptors/request')
			 })
			 .then(()=>{
				 return uninstallMiddleware('mySecondRequestInterceptor', 'interceptors/request')
			 })
			 .then(()=>{
				 return uninstallMiddleware('myResponseInterceptor', 'interceptors/response')
			 })
			 .then(()=>{
				 return uninstallMiddleware('SecondInterceptor', 'interceptors/response')
			 })
			 .then(resolve)
			 .catch(reject);
		});
	}

    function clearConfig(): Promise<void> {
        return new Promise<void>((resolve, reject)=>{
            const redisClient = dbConfig.initializeRedis({
                host: "localhost",
                port: 6379,
                db: 1
            });
            let stream = redisClient.scanStream({
                match: 'config:*'
            });
            stream.on('data', keys => {
                if (keys.length) {
                    var pipeline = redisClient.pipeline();
                    keys.forEach(key => {
                        pipeline.del(key);
                    });
                    pipeline.exec();
                }
            });
            stream.on('end', function () {
                resolve();
            });        
        });
    }		
});