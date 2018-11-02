import { expect } from 'chai';
import { Request, RequestQuery, ResponseToolkit, Server } from 'hapi';
const chalk = require('chalk');
import * as Boom from 'boom';
import * as sinon from 'sinon';
import { cancel, plugin } from '../src/yaral';
import { DropInfo } from 'limitus';

describe('routebox', () => {
  let server: Server;
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => {
    clock = sinon.useFakeTimers();
    server = new Server();
    return server.start();
  });

  afterEach(() => {
    clock.restore();
    return server.stop();
  });

  const id = (req: Request) => (<RequestQuery>req.query).l;

  const testSequence = async (data: { status: number; url: string; left: number; after?: () => void | Promise<void> }[]) => {
    for (const d of data) {
      const res = await server.inject({ app: {}, method: 'GET', url: d.url });
      // tslint:disable-next-line:no-console
      console.log(
        '\t ' +
          chalk.blue('<-') +
          chalk.gray(` ${res.statusCode}, remaining: ${res.headers['x-ratelimit-remaining']}`),
      );
      expect(res.statusCode).to.equal(d.status);
      expect(res.headers['x-ratelimit-remaining']).to.equal(d.left !== undefined ? String(d.left) : d.left);
      if (d.after) {
        return d.after();
      }
    }
  };

  describe('limiting functionality', () => {
    beforeEach(() => {
      return server.register({
        plugin,
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
        { url: '/?l=b', status: 200, left: 1, after: () => clock.tick(1001) },
        { url: '/?l=a', status: 200, left: 1 },
      ]);
    };

    it('limits basic stuff using single string shorthand', () => {
      server.route({
        method: 'get',
        path: '/',
        options: {
          plugins: { yaral: 'a' },
          handler: () => 'ok',
        },
      });

      return testBasicLimit();
    });

    it('limits basic stuff using array shorthand', () => {
      server.route({
        method: 'get',
        path: '/',
        options: {
          plugins: { yaral: ['a'] },
          handler: () => 'ok',
        },
      });

      return testBasicLimit();
    });

    it('limits basic stuff using full config', () => {
      server.route({
        method: 'get',
        path: '/',
        options: {
          plugins: { yaral: { buckets: ['a'] } },
          handler: () => 'ok',
        },
      });

      return testBasicLimit();
    });

    it('uses multiple bucket correctly', () => {
      let res: () => string | Boom = () => Boom.badRequest('400');
      server.route({
        method: 'get',
        path: '/',
        options: {
          plugins: { yaral: ['b', 'a'] },
        },
        handler: (_req, _reply) => res(),
      });

      return testSequence([
        { url: '/?l=a', status: 400, left: 4 },
        {
          url: '/?l=a',
          status: 400,
          left: 3,
          after: () => {
            res = () => 'ok';
          },
        },
        { url: '/?l=a', status: 200, left: 1 },
        { url: '/?l=a', status: 200, left: 0 },
        {
          url: '/?l=a',
          status: 429,
          left: 0,
          after: () => {
            clock.tick(1100);
            res = () => Boom.badRequest('400');
          },
        },
        { url: '/?l=a', status: 400, left: 2 },
        { url: '/?l=a', status: 400, left: 1 },
        { url: '/?l=a', status: 400, left: 0 },
        {
          url: '/?l=a',
          status: 429,
          left: 0,
          after: () => {
            res = () => 'ok';
          },
        },
        { url: '/?l=a', status: 429, left: 0 },
      ]);
    });

    it('does not limit non-matching', () => {
      let res: () => string | Boom = () => Boom.badRequest('400');
      server.route({
        method: 'get',
        path: '/',
        options: {
          plugins: { yaral: ['a'] },
        },
        handler: (_req, _reply) => res(),
      });

      server.route({
        method: 'get',
        path: '/asdf',
        handler: () => 'ok',
      });

      return testSequence([
        { url: '/asdf', status: 200, left: undefined },
        {
          url: '/?l=a',
          status: 400,
          left: undefined,
          after: () => {
            res = () => 'ok';
          },
        },
        { url: '/?l=a', status: 200, left: 1 },
      ]);
    });

    it('limits correctly with continuous mode', () => {
      server.route({
        method: 'get',
        path: '/',
        options: {
          plugins: { yaral: { buckets: ['d'] } },
        },
        handler: () => 'ok',
      });

      return testSequence([
        { url: '/?l=d', status: 200, left: undefined },
        { url: '/?l=d', status: 200, left: undefined },
        { url: '/?l=d', status: 429, left: 0 },
        {
          url: '/?l=d',
          status: 429,
          left: 0,
          after: () => {
            clock.tick(1001);
          },
        },
        { url: '/?l=d', status: 200, left: undefined },
        {
          url: '/?l=d',
          status: 429,
          left: 0,
          after: () => {
            clock.tick(2001);
          },
        },
        { url: '/?l=d', status: 200, left: undefined },
        { url: '/?l=d', status: 200, left: undefined },
        { url: '/?l=d', status: 429, left: 0 },
      ]);
    });
  });

  describe('global handlers', () => {
    beforeEach(() => {
      return server.register({
        plugin,
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
      let res: () => string | Boom = () => Boom.badRequest('400');
      server.route({
        method: 'get',
        path: '/',
        options: {
          plugins: { yaral: ['b'] },
        },
        handler: (_req, _reply) => res(),
      });

      return testSequence([
        { url: '/?l=a', status: 400, left: 4 },
        {
          url: '/?l=a',
          status: 400,
          left: 3,
          after: () => {
            res = () => 'ok';
          },
        },
        { url: '/?l=a', status: 200, left: 1 },
        { url: '/?l=a', status: 200, left: 0 },
        {
          url: '/?l=a',
          status: 429,
          left: 0,
          after: () => {
            clock.tick(1100);
            res = () => Boom.badRequest('400');
          },
        },
        { url: '/?l=a', status: 400, left: 2 },
        { url: '/?l=a', status: 400, left: 1 },
        { url: '/?l=a', status: 400, left: 0 },
        {
          url: '/?l=a',
          status: 429,
          left: 0,
          after: () => {
            res = () => 'ok';
          },
        },
        { url: '/?l=a', status: 429, left: 0 },
      ]);
    });

    it('respects by-route disable', () => {
      server.route({
        method: 'get',
        path: '/asdf',
        options: {
          plugins: { yaral: { enabled: false } },
        },
        handler: () => 'ok',
      });

      return testSequence([{ url: '/asdf', status: 200, left: undefined }]);
    });
  });

  it('respects disabled', async () => {
    await server
      .register({
        plugin,
        options: {
          buckets: [{ id, name: 'a', interval: 1000, max: 2 }],
          enabled: false,
        },
      });
      server.route({
        method: 'get',
        path: '/',
        options: {
          plugins: { yaral: ['a'] },
        },
        handler: (_req, _reply) => 'ok',
      });

    await testSequence([{ url: '/', status: 200, left: undefined }]);
  });

  it('omits headers when requested', async () => {
    await server
      .register({
        plugin,
        options: {
          buckets: [{ id, name: 'a', interval: 1000, max: 2 }],
          includeHeaders: false,
        },
      });
    server.route({
      method: 'get',
      path: '/',
      options: {
        plugins: { yaral: ['a'] },
      },
      handler: (_req, _reply) => 'ok',
    });

    return testSequence([
      { url: '/?l=a', status: 200, left: undefined },
      { url: '/?l=a', status: 200, left: undefined },
      { url: '/?l=a', status: 429, left: undefined },
    ]);
  });

  it('excludes requests', async () => {
    await server
      .register({
        plugin,
        options: {
          buckets: [{ id: () => 42, name: 'a', interval: 1000, max: 2 }],
          exclude: (req: Request) => (<RequestQuery>req.query).excludeGlobal === 'true',
        },
      });
      server.route({
        method: 'get',
        path: '/a',
        options: {
          plugins: {
            yaral: {
              buckets: ['a'],
              exclude: req => (<RequestQuery>req.query).excludeRoute === 'true',
            },
          },
        },
        handler: () => 'ok',
      });

      server.route({
        method: 'get',
        path: '/b',
        options: {
          plugins: {
            yaral: 'a',
          },
          handler: (_req, _reply) => 'ok',
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

  it('runs callback functions', async () => {
    const onPass = sinon.stub();
    const onLimit = sinon.stub();
    await server
      .register({
        // TODO TS freaks out
        plugin: <any> plugin,
        options: {
          onPass,
          onLimit(req: Request) {
            onLimit(req);
            if ((<RequestQuery>req.query).cancel) {
              return cancel;
            }
          },
          buckets: [{ id: () => 42, name: 'a', interval: 1000, max: 1 }],
        },
      });
    server.route({
      method: 'get',
      path: '/a',
      options: {
        plugins: {
          yaral: {
            buckets: ['a'],
          },
        },
        handler: () => 'ok',
      },
    });

    const res = await server.inject({ app: {}, method: 'GET', url: '/a' });
    expect(res.statusCode).to.equal(200);
    expect(onPass.callCount).to.equal(1);
    expect(onLimit.callCount).to.equal(0);
    const res2 = await server.inject({ app: {}, method: 'GET', url: '/a' });
    expect(res2.statusCode).to.equal(429);
    expect(onPass.callCount).to.equal(1);
    expect(onLimit.callCount).to.equal(1);
    const res3 = await server.inject({ app: {}, method: 'GET', url: '/a?cancel=true' });
    expect(res3.statusCode).to.equal(200);
    expect(onPass.callCount).to.equal(1);
    expect(onLimit.callCount).to.equal(2);
  });

  it('allows custom responses', async () => {
    await server
      .register({
        plugin,
        options: {
          onLimit(_req: Request, tk: ResponseToolkit, _data: DropInfo, _reset: number, headers: {
            [key: string]: string | string[];
          }) {
            const r = tk.response('hello').code(429);
            Object.assign(r.headers, headers);
            return r.takeover();
          },
          buckets: [{ id: () => 42, name: 'a', interval: 1000, max: 1 }],
        },
      });
    server.route({
      method: 'get',
      path: '/a',
      options: {
        plugins: {
          yaral: {
            buckets: ['a'],
          },
        },
      },
      handler: () => 'ok',
    });

    await server.inject({ app: {}, method: 'GET', url: '/a' });
    const res = await server.inject({ app: {}, method: 'GET', url: '/a' });
    expect(res.statusCode).to.equal(429);
    expect(res.payload).to.equal('hello');
    expect(res.headers['x-ratelimit-remaining']).to.equal('0');
  });
});
