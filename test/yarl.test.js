const Hapi = require('hapi');
const Boom = require('boom');
const expect = require('chai').expect;
const sinon = require('sinon');
const async = require('async');
const chalk = require('chalk');

describe('routebox', function () {
    var server;
    var clock;
    beforeEach(function (done) {
        clock = sinon.useFakeTimers();
        server = new Hapi.Server();
        server.connection();
        server.start(done);
    });

    afterEach(function (done) {
        server.stop(done);
        clock.restore();
    });

    const id = (req) => req.query.l;

    const testSequence = (data, done) => {
        async.series(data.map((d) => {
            return (callback) => {
                console.log('\t' + chalk.blue('-->') + chalk.gray(` GET ${d.url}`));
                server.inject({ method: 'GET', url: d.url }, (res) => {
                    console.log('\t ' + chalk.blue('<-') + chalk.gray(` ${res.statusCode}, remaining: ${res.headers['x-ratelimit-remaining']}`));
                    expect(res.statusCode).to.equal(d.status);
                    expect(res.headers['x-ratelimit-remaining']).to.equal(d.left);

                    if (d.then) d.then();

                    callback();
                });
            };
        }), done);
    };

    describe('limiting functionality', function () {
        beforeEach(function (done) {
            server.register({
                register: require('../'),
                options: {
                    buckets: [
                        { id, name: 'a', interval: 1000, max: 2 },
                        { id, name: 'b', interval: 1500, max: 5, codes: ['4xx'] },
                        { id, name: 'c', interval: 1000, max: 2, codes: ['xxx'] },
                    ]
                }
            }, done);
        });

        const testBasicLimit = (done) => {
            testSequence([
                { url: '/?l=a', status: 200, left: 1 },
                { url: '/?l=a', status: 200, left: 0 },
                { url: '/?l=a', status: 429, left: 0 },
                { url: '/?l=b', status: 200, left: 1, then: () => clock.tick(1001) },
                { url: '/?l=a', status: 200, left: 1 },
            ], done);
        };

        it('limits basic stuff using single string shorthand', function (done) {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: 'a' },
                    handler: (req, reply) => reply('ok'),
                },
            });

            testBasicLimit(done);
        });

        it('limits basic stuff using array shorthand', function (done) {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['a'] },
                    handler: (req, reply) => reply('ok'),
                },
            });

            testBasicLimit(done);
        });

        it('limits basic stuff using full config', function (done) {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: { buckets: ['a'] }},
                    handler: (req, reply) => reply('ok'),
                },
            });

            testBasicLimit(done);
        });

        it('uses multiple bucket correctly', function (done) {
            var res = () => Boom.badRequest('400');
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['b', 'a'] },
                    handler: (req, reply) => reply(res()),
                },
            });

            testSequence([
                { url: '/?l=a', status: 400, left: 4 },
                { url: '/?l=a', status: 400, left: 3, then: () => { res = () => 'ok'; }},
                { url: '/?l=a', status: 200, left: 1 },
                { url: '/?l=a', status: 200, left: 0 },
                { url: '/?l=a', status: 429, left: 0, then: () => {
                    clock.tick(1100);
                    res = () => Boom.badRequest('400');
                } },
                { url: '/?l=a', status: 400, left: 2 },
                { url: '/?l=a', status: 400, left: 1 },
                { url: '/?l=a', status: 400, left: 0 },
                { url: '/?l=a', status: 429, left: 0, then: () => { res = () => 'ok'; }},
                { url: '/?l=a', status: 429, left: 0 },
            ], done);
        });

        it('does not limit non-matching', function (done) {
            var res = () => Boom.badRequest('400');
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['a'] },
                    handler: (req, reply) => reply(res()),
                },
            });

            server.route({
                method: 'get', path: '/asdf',
                config: {
                    handler: (req, reply) => reply('ok'),
                },
            });

            testSequence([
                { url: '/asdf', status: 200, left: undefined },
                { url: '/?l=a', status: 400, left: undefined, then: () => { res = () => 'ok'; }},
                { url: '/?l=a', status: 200, left: 1 },
            ], done);
        });
    });

    describe('global handlers', function () {
        beforeEach(function (done) {
            server.register({
                register: require('../'),
                options: {
                    buckets: [
                        { id, name: 'a', interval: 1000, max: 2 },
                        { id, name: 'b', interval: 1500, max: 5, codes: ['4xx'] },
                        { id, name: 'c', interval: 1000, max: 2, codes: ['xxx'] },
                    ],
                    default: ['a']
                }
            }, done);
        })

        it('limits correctly', function (done) {
            var res = () => Boom.badRequest('400');
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['b'] },
                    handler: (req, reply) => reply(res()),
                },
            });

            testSequence([
                { url: '/?l=a', status: 400, left: 4 },
                { url: '/?l=a', status: 400, left: 3, then: () => { res = () => 'ok'; }},
                { url: '/?l=a', status: 200, left: 1 },
                { url: '/?l=a', status: 200, left: 0 },
                { url: '/?l=a', status: 429, left: 0, then: () => {
                    clock.tick(1100);
                    res = () => Boom.badRequest('400');
                } },
                { url: '/?l=a', status: 400, left: 2 },
                { url: '/?l=a', status: 400, left: 1 },
                { url: '/?l=a', status: 400, left: 0 },
                { url: '/?l=a', status: 429, left: 0, then: () => { res = () => 'ok'; }},
                { url: '/?l=a', status: 429, left: 0 },
            ], done);
        });

        it('respects by-route disable', function (done) {
            server.route({
                method: 'get', path: '/asdf',
                config: {
                    plugins: { yaral: { enabled: false }},
                    handler: (req, reply) => reply('ok'),
                },
            });

            testSequence([
                { url: '/asdf', status: 200, left: undefined },
            ], done);
        })
    });

    it('respects disabled', function (done) {
        server.register({
            register: require('../'),
            options: {
                buckets: [
                    { id, name: 'a', interval: 1000, max: 2 },
                ],
                enabled: false,
            }
        }, () => {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['a'] },
                    handler: (req, reply) => reply('ok'),
                },
            });

            testSequence([
                { url: '/', status: 200, left: undefined },
            ], done);
        });
    });

    it('omits headers when requested', function (done) {
        server.register({
            register: require('../'),
            options: {
                buckets: [
                    { id, name: 'a', interval: 1000, max: 2 },
                ],
                includeHeaders: false,
            }
        }, () => {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['a'] },
                    handler: (req, reply) => reply('ok'),
                },
            });

            testSequence([
                { url: '/?l=a', status: 200, left: undefined },
                { url: '/?l=a', status: 200, left: undefined },
                { url: '/?l=a', status: 429, left: undefined },
            ], done);
        });
    });

    it('excludes requests', function (done) {
        server.register({
            register: require('../'),
            options: {
                buckets: [
                    { id: () => 42, name: 'a', interval: 1000, max: 2 },
                ],
                exclude: (req) => req.query.excludeGlobal === 'true'
            }
        }, () => {
            var res = () => Boom.badRequest('400');
            server.route({
                method: 'get', path: '/a',
                config: {
                    plugins: {
                        yaral: {
                            buckets: ['a'],
                            exclude: (req) => req.query.excludeRoute === 'true',
                        },
                    },
                    handler: (req, reply) => reply('ok'),
                },
            });

            server.route({
                method: 'get', path: '/b',
                config: {
                    plugins: {
                        yaral: 'a',
                    },
                    handler: (req, reply) => reply('ok'),
                },
            });

            testSequence([
                { url: '/a?excludeGlobal=true', status: 200, left: undefined },
                { url: '/b?excludeGlobal=true', status: 200, left: undefined },
                { url: '/a?excludeRoute=true', status: 200, left: undefined },

                { url: '/a?excludeRoute=false', status: 200, left: 1 },
                { url: '/a?excludeGlobal=false', status: 200, left: 0 },
                { url: '/b?excludeRoute=true', status: 429, left: 0 },

                { url: '/a?excludeGlobal=true', status: 200, left: undefined },
                { url: '/b?excludeGlobal=true', status: 200, left: undefined },
                { url: '/a?excludeRoute=true', status: 200, left: undefined },
            ], done);
        });
    });
});
