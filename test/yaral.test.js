const Hapi = require('hapi');
const Boom = require('boom');
const expect = require('chai').expect;
const sinon = require('sinon');
const chalk = require('chalk');
const { yaral, cancel } = require('../src/yaral.ts');

describe('routebox', function () {
    let server;
    let clock;
    beforeEach(() => {
        clock = sinon.useFakeTimers();
        server = new Hapi.Server();
        server.connection();
        return server.start();
    });

    afterEach(() => {
        clock.restore();
        return server.stop();
    });

    const id = req => req.query.l;

    const testSequence = data => {
        let chain = Promise.resolve();
        data.forEach(d => {
            chain = chain.then(() => server.inject({ method: 'GET', url: d.url }))
            .then(res => {
                console.log('\t ' + chalk.blue('<-') + chalk.gray(` ${res.statusCode}, remaining: ${res.headers['x-ratelimit-remaining']}`));
                expect(res.statusCode).to.equal(d.status);
                expect(res.headers['x-ratelimit-remaining']).to.equal(d.left);
                if (d.then) {
                    return d.then();
                }
            });
        });
        return chain;
    };

    describe('limiting functionality', () => {
        beforeEach(() => {
            return server.register({
                register: yaral,
                options: {
                    buckets: [
                        { id, name: 'a', interval: 1000, max: 2 },
                        { id, name: 'b', interval: 1500, max: 5, codes: ['4xx'] },
                        { id, name: 'c', interval: 1000, max: 2, codes: ['xxx'] },
                        { id, name: 'd', interval: 2000, max: 2, mode: 'continuous' },
                    ],
                },
            });
        });

        const testBasicLimit = () => {
            return testSequence([
                { url: '/?l=a', status: 200, left: 1 },
                { url: '/?l=a', status: 200, left: 0 },
                { url: '/?l=a', status: 429, left: 0 },
                { url: '/?l=b', status: 200, left: 1, then: () => clock.tick(1001) },
                { url: '/?l=a', status: 200, left: 1 },
            ]);
        };

        it('limits basic stuff using single string shorthand', () => {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: 'a' },
                    handler: (req, reply) => reply('ok'),
                },
            });

            return testBasicLimit();
        });

        it('limits basic stuff using array shorthand', () => {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['a'] },
                    handler: (req, reply) => reply('ok'),
                },
            });

            return testBasicLimit();
        });

        it('limits basic stuff using full config', () => {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: { buckets: ['a'] }},
                    handler: (req, reply) => reply('ok'),
                },
            });

            return testBasicLimit();
        });

        it('uses multiple bucket correctly', () => {
            let res = () => Boom.badRequest('400');
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['b', 'a'] },
                    handler: (req, reply) => reply(res()),
                },
            });

            return testSequence([
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
            ]);
        });

        it('does not limit non-matching', () => {
            let res = () => Boom.badRequest('400');
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

            return testSequence([
                { url: '/asdf', status: 200, left: undefined },
                { url: '/?l=a', status: 400, left: undefined, then: () => { res = () => 'ok'; }},
                { url: '/?l=a', status: 200, left: 1 },
            ]);
        });

        it('limits correctly with continuous mode', () => {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: { buckets: ['d'] }},
                    handler: (req, reply) => reply('ok'),
                },
            });

            return testSequence([
                { url: '/?l=d', status: 200, left: undefined },
                { url: '/?l=d', status: 200, left: undefined },
                { url: '/?l=d', status: 429, left: 0 },
                { url: '/?l=d', status: 429, left: 0, then: () => { clock.tick(1001); } },
                { url: '/?l=d', status: 200, left: undefined },
                { url: '/?l=d', status: 429, left: 0, then: () => { clock.tick(2001); }  },
                { url: '/?l=d', status: 200, left: undefined },
                { url: '/?l=d', status: 200, left: undefined },
                { url: '/?l=d', status: 429, left: 0 },
            ]);
        });
    });

    describe('global handlers', () => {
        beforeEach(() => {
            return server.register({
                register: yaral,
                options: {
                    buckets: [
                        { id, name: 'a', interval: 1000, max: 2 },
                        { id, name: 'b', interval: 1500, max: 5, codes: ['4xx'] },
                        { id, name: 'c', interval: 1000, max: 2, codes: ['xxx'] },
                    ],
                    default: ['a'],
                },
            });
        });

        it('limits correctly', () => {
            let res = () => Boom.badRequest('400');
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['b'] },
                    handler: (req, reply) => reply(res()),
                },
            });

            return testSequence([
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
            ]);
        });

        it('respects by-route disable', () => {
            server.route({
                method: 'get', path: '/asdf',
                config: {
                    plugins: { yaral: { enabled: false }},
                    handler: (req, reply) => reply('ok'),
                },
            });

            return testSequence([
                { url: '/asdf', status: 200, left: undefined },
            ]);
        });
    });

    it('respects disabled', () => {
        return server.register({
            register: yaral,
            options: {
                buckets: [
                    { id, name: 'a', interval: 1000, max: 2 },
                ],
                enabled: false,
            },
        })
        .then(() => {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['a'] },
                    handler: (req, reply) => reply('ok'),
                },
            });

            return testSequence([
                { url: '/', status: 200, left: undefined },
            ]);
        });
    });

    it('omits headers when requested', () => {
        return server.register({
            register: yaral,
            options: {
                buckets: [
                    { id, name: 'a', interval: 1000, max: 2 },
                ],
                includeHeaders: false,
            },
        })
        .then(() => {
            server.route({
                method: 'get', path: '/',
                config: {
                    plugins: { yaral: ['a'] },
                    handler: (req, reply) => reply('ok'),
                },
            });

            return testSequence([
                { url: '/?l=a', status: 200, left: undefined },
                { url: '/?l=a', status: 200, left: undefined },
                { url: '/?l=a', status: 429, left: undefined },
            ]);
        });
    });

    it('excludes requests', () => {
        return server.register({
            register: yaral,
            options: {
                buckets: [
                    { id: () => 42, name: 'a', interval: 1000, max: 2 },
                ],
                exclude: (req) => req.query.excludeGlobal === 'true',
            },
        })
        .then(() => {
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

            return testSequence([
                { url: '/a?excludeGlobal=true', status: 200, left: undefined },
                { url: '/b?excludeGlobal=true', status: 200, left: undefined },
                { url: '/a?excludeRoute=true', status: 200, left: undefined },

                { url: '/a?excludeRoute=false', status: 200, left: 1 },
                { url: '/a?excludeGlobal=false', status: 200, left: 0 },
                { url: '/b?excludeRoute=true', status: 429, left: 0 },

                { url: '/a?excludeGlobal=true', status: 200, left: undefined },
                { url: '/b?excludeGlobal=true', status: 200, left: undefined },
                { url: '/a?excludeRoute=true', status: 200, left: undefined },
            ]);
        });
    });

    it('runs callback functions', () => {
        const onPass = sinon.stub();
        const onLimit = sinon.stub();
        return server.register({
            register: yaral,
            options: {
                onPass,
                onLimit: (req) => {
                    onLimit(req);
                    return req.query.cancel ? cancel : null;
                },
                buckets: [
                    { id: () => 42, name: 'a', interval: 1000, max: 1 },
                ],
            },
        })
        .then(() => {
            server.route({
                method: 'get', path: '/a',
                config: {
                    plugins: {
                        yaral: {
                            buckets: ['a'],
                        },
                    },
                    handler: (req, reply) => reply('ok'),
                },
            });

            return server.inject({ method: 'GET', url: '/a' })
            .then(res => {
                expect(res.statusCode).to.equal(200);
                expect(onPass.callCount).to.equal(1);
                expect(onLimit.callCount).to.equal(0);
                return server.inject({ method: 'GET', url: '/a' });
            })
            .then(res => {
                expect(res.statusCode).to.equal(429);
                expect(onPass.callCount).to.equal(1);
                expect(onLimit.callCount).to.equal(1);
                return server.inject({ method: 'GET', url: '/a?cancel=true' });
            })
            .then(res => {
                expect(res.statusCode).to.equal(200);
                expect(onPass.callCount).to.equal(1);
                expect(onLimit.callCount).to.equal(2);
            });
        });
    });
});
