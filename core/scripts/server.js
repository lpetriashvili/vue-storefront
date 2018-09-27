const fs = require('fs')
const path = require('path')
const express = require('express')
const rootPath = require('app-root-path').path
const resolve = file => path.resolve(rootPath, file)
const config = require('config')
const TagCache = require('redis-tag-cache').default
const utils = require('./server/utils')
const compile = require('lodash.template')
const compileOptions = {
  escape: /{{([^{][\s\S]+?[^}])}}/g,
  interpolate: /{{{([\s\S]+?)}}}/g
}
const isProd = process.env.NODE_ENV === 'production'
process.noDeprecation = true

const app = express()

let cache
if (config.server.useOutputCache) {
  cache = new TagCache({
    redis: config.redis,
    defaultTimeout: config.server.outputCacheDefaultTtl // Expire records after a day (even if they weren't invalidated)
  })
  console.log('Redis cache set', config.redis)
}

const templatesCache = {}
let renderer
if (isProd) {
  // In production: create server renderer using server bundle and index HTML
  // template from real fs.
  // The server bundle is generated by vue-ssr-webpack-plugin.
  const bundle = require(resolve('dist/vue-ssr-bundle.json'))
  // src/index.template.html is processed by html-webpack-plugin to inject
  // build assets and output as dist/index.html.
  // TODO: Add dynamic templates loading from (config based?) list
  const template = fs.readFileSync(resolve('dist/index.html'), 'utf-8')
  templatesCache['default'] = compile(template, compileOptions)
  renderer = createRenderer(bundle)
} else {
  // In development: setup the dev server with watch and hot-reload,
  // and create a new renderer on bundle / index template update.
  require(resolve('core/build/dev-server'))(app, (bundle, template) => {
    templatesCache['default'] = compile(template, compileOptions)
    renderer = createRenderer(bundle)
  })
}

function createRenderer (bundle, template) {
  // https://github.com/vuejs/vue/blob/dev/packages/vue-server-renderer/README.md#why-use-bundlerenderer
  return require('vue-server-renderer').createBundleRenderer(bundle, {
    cache: require('lru-cache')({
      max: 1000,
      maxAge: 1000 * 60 * 15
    })
  })
}

const serve = (path, cache, options) => express.static(resolve(path), Object.assign({
  maxAge: cache && isProd ? 60 * 60 * 24 * 30 : 0
}, options))

const themeRoot = require('../build/theme-path')

app.use('/dist', serve('dist', true))
app.use('/assets', serve(themeRoot + '/assets', true))
app.use('/service-worker.js', serve('dist/service-worker.js', {
  setHeaders: {'Content-Type': 'text/javascript; charset=UTF-8'}
}))

const serverExtensions = require(resolve('src/server'))
serverExtensions.registerUserServerRoutes(app)

app.get('/invalidate', (req, res) => {
  if (config.server.useOutputCache) {
    if (req.query.tag && req.query.key) { // clear cache pages for specific query tag
      if (req.query.key !== config.server.invalidateCacheKey) {
        console.error('Invalid cache invalidation key')
        utils.apiStatus(res, 'Invalid cache invalidation key', 500)
        return
      }
      console.log(`Clear cache request for [${req.query.tag}]`)
      let tags = []
      if (req.query.tag === '*') {
        tags = config.server.availableCacheTags
      } else {
        tags = req.query.tag.split(',')
      }
      const subPromises = []
      tags.forEach(tag => {
        if (config.server.availableCacheTags.indexOf(tag) >= 0 || config.server.availableCacheTags.find(t => {
          return tag.indexOf(t) === 0
        })) {
          subPromises.push(cache.invalidate(tag).then(() => {
            console.log(`Tags invalidated successfully for [${tag}]`)
          }))
        } else {
          console.error(`Invalid tag name ${tag}`)
        }
      })
      Promise.all(subPromises).then(r => {
        utils.apiStatus(res, `Tags invalidated successfully [${req.query.tag}]`, 200)
      }).catch(error => {
        utils.apiStatus(res, error, 500)
        console.error(error)
      })
    } else {
      utils.apiStatus(res, 'Invalid parameters for Clear cache request', 500)
      console.error('Invalid parameters for Clear cache request')
    }
  } else {
    utils.apiStatus(res, 'Cache invalidation is not required, output cache is disabled', 200)
  }
})

app.get('*', (req, res, next) => {
  const s = Date.now()
  const errorHandler = err => {
    if (err && err.code === 404) {
      res.redirect('/page-not-found')
    } else {
      // Render Error Page or Redirect
      // TODO: Add error page handler
      res.status(500).end('500 | Internal Server Error')
      console.error(`Error during render : ${req.url}`)
      console.error(err)
      next()
    }
  }

  const dynamicRequestHandler = renderer => {
    if (!renderer) {
      res.setHeader('Content-Type', 'text/html')
      res.status(202).end('<html lang="en">\n' +
          '    <head>\n' +
          '      <meta charset="utf-8">\n' +
          '      <title>Loading</title>\n' +
          '      <meta http-equiv="refresh" content="10">\n' +
          '    </head>\n' +
          '    <body>\n' +
          '      Vue Storefront: waiting for compilation... refresh in 30s :-) Thanks!\n' +
          '    </body>\n' +
          '  </html>')
      return next()
    }
    const context = { url: req.url, serverOutputTemplate: 'default', meta: null, currentRoute: null/** will be set by Vue */, storeCode: req.header('x-vs-store-code') ? req.header('x-vs-store-code') : process.env.STORE_CODE, app: app, response: res, request: req }
    renderer.renderToString(context).then(output => {
      if (!res.get('content-type')) {
        res.setHeader('Content-Type', 'text/html')
      }
      if (config.server.useOutputCacheTagging) {
        const tagsArray = Array.from(context.state.requestContext.outputCacheTags)
        const cacheTags = tagsArray.join(' ')
        res.setHeader('X-VS-Cache-Tags', cacheTags)
        if (context.serverOutputTemplate) { // case when we've got the template name back from vue app
          if (templatesCache[context.serverOutputTemplate]) { // please look at: https://github.com/vuejs/vue/blob/79cabadeace0e01fb63aa9f220f41193c0ca93af/src/server/template-renderer/index.js#L87 for reference
            output = templatesCache[context.serverOutputTemplate](context).replace('<!--vue-ssr-outlet-->', output)
          }
        }
        if (config.server.useOutputCache && cache) {
          cache.set(
            'page:' + req.url,
            output,
            tagsArray
          ).catch(errorHandler)
        }
        console.log(`cache tags for the request: ${cacheTags}`)
      }
      res.end(output)
      console.log(`whole request [${req.url}]: ${Date.now() - s}ms`)
      next()
    }).catch(errorHandler)
  }

  if (config.server.useOutputCache && cache) {
    cache.get(
      'page:' + req.url
    ).then(output => {
      if (output !== null) {
        res.setHeader('Content-Type', 'text/html')
        res.setHeader('X-VS-Cache', 'Hit')
        res.end(output)
        console.log(`cache hit [${req.url}], cached request: ${Date.now() - s}ms`)
        next()
      } else {
        res.setHeader('Content-Type', 'text/html')
        res.setHeader('X-VS-Cache', 'Miss')
        console.log(`cache miss [${req.url}], request: ${Date.now() - s}ms`)
        dynamicRequestHandler(renderer) // render response
      }
    }).catch(errorHandler)
  } else {
    dynamicRequestHandler(renderer)
  }
})

let port = process.env.PORT || config.server.port
const host = process.env.HOST || config.server.host
const start = () => {
  app.listen(port, host)
    .on('listening', () => {
      console.log(`Vue Storefront Server started at http://${host}:${port}`)
    })
    .on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        port = parseInt(port) + 1
        console.log(`The port is already in use, trying ${port}`)
        start()
      }
    })
}
start()
