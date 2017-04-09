/*global describe, it, expect, beforeEach, afterEach */
const underTest = require('../src/commands/add-cognito-user-pool-trigger'),
	create = require('../src/commands/create'),
	destroyObjects = require('./util/destroy-objects'),
	shell = require('shelljs'),
	tmppath = require('../src/util/tmppath'),
	aws = require('aws-sdk'),
	awsRegion = require('./util/test-aws-region');

describe('addCognitoUserPoolTrigger', () => {
	'use strict';
	let workingdir, testRunName, newObjects, config, lambda, cognitoIdentityServiceProvider;
	beforeEach((done) => {
		cognitoIdentityServiceProvider = new aws.CognitoIdentityServiceProvider({ region: awsRegion });
		workingdir = tmppath();
		lambda = new aws.Lambda({ region: awsRegion });
		testRunName = 'test' + Date.now();
		newObjects = { workingdir: workingdir };
		shell.mkdir(workingdir);
		cognitoIdentityServiceProvider.createUserPool({ PoolName: testRunName }).promise().then(result => {
			newObjects.userPoolId = result.UserPool.Id;
			config = {
				'user-pool-id': result.UserPool.Id,
				source: workingdir
			};
		}).then(done);
	});
	afterEach(done => {
		destroyObjects(newObjects).then(done, done.fail);
	});
	it('fails when the pool ID is not defined in options', done => {
		config['user-pool-id'] = '';
		config.events = 'PreSignUp';
		underTest(config)
		.then(done.fail, reason => {
			expect(reason).toEqual('user pool id not specified. provide with --user-pool-id');
			done();
		});
	});
	it('fails when the source dir does not contain the project config file', done => {
		config.events = 'PreSignUp';
		underTest(config).then(done.fail, reason => {
			expect(reason).toEqual('claudia.json does not exist in the source folder');
			done();
		});
	});
	it('fails when the events are not specified in the options', done => {
		config.events = '';
		underTest(config).then(done.fail, reason => {
			expect(reason).toEqual('events not specified. provide with --events');
			done();
		});
	});
	describe('when params are valid', () => {
		let createConfig;
		const createLambda = function () {
			return create(createConfig)
			.then(result => {
				newObjects.lambdaRole = result.lambda && result.lambda.role;
				newObjects.lambdaFunction = result.lambda && result.lambda.name;
			});
		};
		beforeEach(() => {
			createConfig = { name: testRunName, region: awsRegion, source: workingdir, handler: 'main.handler' };
			shell.cp('-r', 'spec/test-projects/cognito-trigger-reject/*', workingdir);
		});
		it('wires up the unqualified lambda function if no version requested', done => {
			let functionArn;
			config.events = 'PreAuthentication';
			createLambda()
			.then(() => lambda.getFunctionConfiguration({ FunctionName: testRunName }).promise())
			.then(lambdaResult => functionArn = lambdaResult.FunctionArn)
			.then(() => underTest(config))
			.then(() => cognitoIdentityServiceProvider.describeUserPool({UserPoolId: newObjects.userPoolId}).promise())
			.then(result => {
				expect(result.UserPool.LambdaConfig).toEqual({PreAuthentication: functionArn});
			})
			.then(done, done.fail);
		});
		it('adds multiple events if specified', done => {
			let functionArn;
			config.events = 'PreAuthentication,PreSignUp';
			createLambda()
			.then(() => lambda.getFunctionConfiguration({ FunctionName: testRunName }).promise())
			.then(lambdaResult => functionArn = lambdaResult.FunctionArn)
			.then(() => underTest(config))
			.then(() => cognitoIdentityServiceProvider.describeUserPool({UserPoolId: newObjects.userPoolId}).promise())
			.then(result => {
				expect(result.UserPool.LambdaConfig).toEqual({
					PreAuthentication: functionArn,
					PreSignUp: functionArn
				});
			})
			.then(done, done.fail);

		});
		it('binds to an alias, if the version is provided', done => {
			let functionArn;
			config.events = 'PreAuthentication';
			createConfig.version = 'special';
			config.version = 'special';
			createLambda()
			.then(() => lambda.getFunctionConfiguration({ FunctionName: testRunName, Qualifier: 'special' }).promise())
			.then(lambdaResult => functionArn = lambdaResult.FunctionArn)
			.then(() => underTest(config))
			.then(() => cognitoIdentityServiceProvider.describeUserPool({UserPoolId: newObjects.userPoolId}).promise())
			.then(result => {
				expect(result.UserPool.LambdaConfig).toEqual({PreAuthentication: functionArn});
			})
			.then(done, done.fail);
		});
		it('adds permission for the trigger to run', done => {
			config.events = 'PreSignUp';
			createLambda()
			.then(() => underTest(config))
			.then(() => cognitoIdentityServiceProvider.createUserPoolClient(
				{
					ClientName: 'TestClient',
					UserPoolId: newObjects.userPoolId,
					GenerateSecret: false,
					ExplicitAuthFlows: ['ADMIN_NO_SRP_AUTH']
				}).promise())
			.then(result => cognitoIdentityServiceProvider.signUp(
				{
					ClientId: result.UserPoolClient.ClientId,
					Username: 'Bob-123',
					Password: 'Password1!'
				}).promise())
			.then(done.fail, err => {
				expect(err.code).toEqual('UserLambdaValidationException');
				expect(err.message).toEqual(`PreSignUp failed with error rejected by lambda ${testRunName}.`);
				done();
			});
		});
	});
});
