const fs = require('fs');
const path = require('path');
const serialize = require('serialize-javascript');
const route_manager = require('./route_manager.js');
const templates = require('./templates.js');
const create_app = require('./utils/create_app.js');
const create_watcher = require('./utils/create_watcher.js');
const compilers = require('./utils/compilers.js');
const generate_asset_cache = require('./utils/generate_asset_cache.js');
const escape_html = require('escape-html');
const { dest, dev } = require('./config.js');

function connect_dev() {
	create_app();

	const watcher = create_watcher();

	let asset_cache;

	const middleware = compose_handlers([
		require('webpack-hot-middleware')(compilers.client, {
			reload: true,
			path: '/__webpack_hmr',
			heartbeat: 10 * 1000
		}),

		(req, res, next) => {
			watcher.ready.then(cache => {
				asset_cache = cache;
				next();
			});
		},

		set_req_pathname,

		get_asset_handler({
			filter: pathname => pathname === '/index.html',
			type: 'text/html',
			cache: 'max-age=600',
			fn: () => asset_cache.client.index
		}),

		get_asset_handler({
			filter: pathname => pathname === '/service-worker.js',
			type: 'application/javascript',
			cache: 'max-age=600',
			fn: () => asset_cache.client.service_worker
		}),

		get_asset_handler({
			filter: pathname => pathname.startsWith('/client/'),
			type: 'application/javascript',
			cache: 'max-age=31536000',
			fn: pathname => asset_cache.client.chunks[pathname]
		}),

		get_route_handler(() => asset_cache),

		get_not_found_handler(() => asset_cache)
	]);

	middleware.close = () => {
		watcher.close();
		// TODO shut down chokidar
	};

	return middleware;
}

function connect_prod() {
	const asset_cache = generate_asset_cache(
		read_json(path.join(dest, 'stats.client.json')),
		read_json(path.join(dest, 'stats.server.json'))
	);

	const middleware = compose_handlers([
		set_req_pathname,

		get_asset_handler({
			filter: pathname => pathname === '/index.html',
			type: 'text/html',
			cache: 'max-age=600',
			fn: () => asset_cache.client.index
		}),

		get_asset_handler({
			filter: pathname => pathname === '/service-worker.js',
			type: 'application/javascript',
			cache: 'max-age=600',
			fn: () => asset_cache.client.service_worker
		}),

		get_asset_handler({
			filter: pathname => pathname.startsWith('/client/'),
			type: 'application/javascript',
			cache: 'max-age=31536000',
			fn: pathname => asset_cache.client.chunks[pathname]
		}),

		get_route_handler(() => asset_cache),

		get_not_found_handler(() => asset_cache)
	]);

	// here for API consistency between dev, and prod, but
	// doesn't actually need to do anything
	middleware.close = () => {};

	return middleware;
}

module.exports = dev ? connect_dev : connect_prod;

function set_req_pathname(req, res, next) {
	req.pathname = req.url.replace(/\?.+/, '');
	next();
}

function get_asset_handler(opts) {
	return (req, res, next) => {
		if (!opts.filter(req.pathname)) return next();

		res.setHeader('Content-Type', opts.type);
		res.setHeader('Cache-Control', opts.cache);

		res.end(opts.fn(req.pathname));
	};
}

const resolved = Promise.resolve();

function get_route_handler(fn) {
	function handle_route(route, req, res, next, { client, server }) {
		req.params = route.exec(req.pathname);

		const mod = require(server.entry)[route.id];

		if (route.type === 'page') {
			// preload main.js and current route
			// TODO detect other stuff we can preload? images, CSS, fonts?
			res.setHeader('Link', `<${client.main_file}>;rel="preload";as="script", <${client.routes[route.id]}>;rel="preload";as="script"`);

			const data = { params: req.params, query: req.query };

			if (mod.preload) {
				const promise = Promise.resolve(mod.preload(req)).then(preloaded => {
					const serialized = try_serialize(preloaded);
					Object.assign(data, preloaded);

					return { rendered: mod.render(data), serialized };
				});

				return templates.stream(res, 200, {
					scripts: promise.then(({ serialized }) => {
						const main = `<script src='${client.main_file}'></script>`;

						if (serialized) {
							return `<script>__SAPPER__ = { preloaded: ${serialized} };</script>${main}`;
						}

						return main;
					}),
					html: promise.then(({ rendered }) => rendered.html),
					head: promise.then(({ rendered }) => `<noscript id='sapper-head-start'></noscript>${rendered.head}<noscript id='sapper-head-end'></noscript>`),
					styles: promise.then(({ rendered }) => (rendered.css && rendered.css.code ? `<style>${rendered.css.code}</style>` : ''))
				});
			} else {
				const { html, head, css } = mod.render(data);

				const page = templates.render(200, {
					scripts: `<script src='${client.main_file}'></script>`,
					html,
					head: `<noscript id='sapper-head-start'></noscript>${head}<noscript id='sapper-head-end'></noscript>`,
					styles: (css && css.code ? `<style>${css.code}</style>` : '')
				});

				res.end(page);
			}
		}

		else {
			const method = req.method.toLowerCase();
			// 'delete' cannot be exported from a module because it is a keyword,
			// so check for 'del' instead
			const method_export = method === 'delete' ? 'del' : method;
			const handler = mod[method_export];
			if (handler) {
				handler(req, res, next);
			} else {
				// no matching handler for method — 404
				next();
			}
		}
	}

	return function find_route(req, res, next) {
		const url = req.pathname;

		// whatever happens, we're going to serve some HTML
		res.setHeader('Content-Type', 'text/html');

		resolved
			.then(() => {
				for (const route of route_manager.routes) {
					if (route.test(url)) return handle_route(route, req, res, next, fn());
				}

				// no matching route — 404
				next();
			})
			.catch(err => {
				res.statusCode = 500;
				res.end(templates.render(500, {
					title: (err && err.name) || 'Internal server error',
					url,
					error: escape_html(err && (err.details || err.message || err) || 'Unknown error'),
					stack: err && err.stack.split('\n').slice(1).join('\n')
				}));
			});
	};
}

function get_not_found_handler(fn) {
	return function handle_not_found(req, res) {
		const asset_cache = fn();

		res.statusCode = 404;
		res.end(templates.render(404, {
			title: 'Not found',
			status: 404,
			method: req.method,
			scripts: `<script src='${asset_cache.client.main_file}'></script>`,
			url: req.url
		}));
	};
}

function compose_handlers(handlers) {
	return (req, res, next) => {
		let i = 0;
		function go() {
			const handler = handlers[i];

			if (handler) {
				handler(req, res, () => {
					i += 1;
					go();
				});
			} else {
				next();
			}
		}

		go();
	};
}

function read_json(file) {
	return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function try_serialize(data) {
	try {
		return serialize(data);
	} catch (err) {
		return null;
	}
}