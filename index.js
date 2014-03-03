#!/usr/bin/env node
var colors = require('colors')
  , nopt = require('nopt')
  , mkdirp = require('mkdirp')
  , rimraf = require('rimraf')
  , fs = require('fs')
  , path = require('path')
  , os = require('os')
  , request = require('request')
  , spawn = require('child_process').spawn
  , tar = require('tar')
  , log = require('npmlog')
  , ncp = require('ncp').ncp
  , stdio = process.binding('stdio')
  , zlib = require('zlib')
  , chain = require('slide').chain
  , asyncMap = require('slide').asyncMap
  , knownOpts = { loglevel: ['verbose', 'info', 'silent']
                , help: Boolean
                , version: Boolean
                , npm: Boolean
                }
  , shortHand = { verbose: ['--loglevel', 'verbose']
                , h: ['--help']
                , H: ['--help']
                , v: ['--version']
                , n: ['--npm']
                }
  , parsed = nopt(knownOpts, shortHand)
  , platform = os.platform()
  , arch = os.arch()
  , tmp = os.tmpdir()
  , nodeUrl = 'http://nodejs.org/dist/'

log.heading = 'en'
var EN_PREFIX = process.env.EN_PREFIX
              ? process.env.EN_PREFIX
              : '/usr/local'
var VERSIONS_DIR = path.join(EN_PREFIX, 'en', 'versions')

var prev = path.join(VERSIONS_DIR, '.prev')
fs.existsSync(VERSIONS_DIR) || mkdirp.sync(VERSIONS_DIR)

if (parsed.help) {
  return help()
}

if (parsed.version) {
  console.log('en', 'v'+require('./package').version)
}

if (parsed.loglevel) {
  log.level = parsed.loglevel
}

function help() {
  console.log()
  console.log()
  console.log(' Usage: en [options] [COMMAND] [args]')
  console.log()
  console.log(' Commands:')
  console.log()
  console.log('   en', '                          ', 'Output versions installed')
  console.log('   en latest', '                   ', 'Install or activate the latest node release')
  console.log('   en stable', '                   ', 'Install or activate the latest stable node release')
  console.log('   en <version>', '                ', 'Install node <version>')
  console.log('   en use <version> [args ...]', ' ', 'Execute node <version> with [args ...]')
  console.log('   en bin <version>', '            ', 'Output bin path for <version>')
  console.log('   en rm <version ...>', '         ', 'Remove the given version(s)')
  console.log('   en prev', '                     ', 'Revert to the previously activated version')
  console.log('   en --latest', '                 ', 'Output the latest node version available')
  console.log('   en --stable', '                 ', 'Output the latest stable node version available')
  console.log('   en ls', '                       ', 'Output the versions of node available')
  console.log()
  console.log(' Options:')
  console.log()
  console.log('   -v, --version', '   ', 'Output current version of en')
  console.log('   -h, --help', '      ', 'Display help information')
  console.log('   -n, --npm', '       ', 'Use default npm')
  console.log()
  console.log(' Aliases:')
  console.log()
  console.log('   which', '   ', 'bin')
  console.log('   use', '     ', 'as')
  console.log('   list', '    ', 'ls')
  console.log('   -', '       ', 'rm')
  console.log()
  process.exit()
}

function tarball_url(v) {
  return nodeUrl+'v'+v+'/node-v'+v+
    '-'+platform+'-'+arch+'.tar.gz'
}

function current_version() {
  var v = process.version
  return v.substr(1, v.length-1)
}

function versions_paths(cb) {
  fs.readdir(VERSIONS_DIR, function(err, paths) {
    cb && cb(null, paths)
  })
}

function available_versions(cb) {
  log.verbose('fetching available versions')
  request.get(nodeUrl, function(err, res, body) {
    if (err) return cb && cb(err)
    var lines = body.split('\n')
    lines = lines.reduce(function(set, line) {
      var vers = line.match(/>v([^\/]+)/)
      if (vers && vers[1]) {
        if (!~set.indexOf(vers[1])) set.push(vers[1])
      }
      return set
    }, [])
    .sort(sort_versions)
    lines = lines.filter(function(version) {
      var vers = version.split('.')
      if (vers.length >= 3) {
        return (+vers[1] > 8 ||
               +vers[1] === 8 &&
               +vers[2] >= 6)
      }
      return false
    }).filter(function(version) {
      return /[0-9]+\.[0-9]+\.[0-9]+$/.test(version)
    })
    return cb && cb(null, lines)
  })
}

function display_versions() {
  available_versions(function(err, versions) {
    if (err) {
      log.error('unable to get versions', err)
      process.exit(1)
    }
    console.log()
    versions.forEach(function(v) {
      var p = path.join(VERSIONS_DIR, v)
      if (fs.existsSync(p)) {
        var o = colors.green(v)
        if (current_version() === v) {
          console.log(' o'.cyan, o)
        } else {
          console.log('   ', o)
        }
      } else {
        console.log('   ', colors.grey(v))
      }
    })
  })
}

function install_node(v, cb) {
  available_versions(function(err, versions) {
    if (err) {
      log.error('unable to get versions', err)
      process.exit(1)
    }
    if (!~versions.indexOf(v)) {
      log.error('invalid version', v)
      process.exit(1)
    }
    var dir = path.join(VERSIONS_DIR, v)
    fs.exists(dir, function(e) {
      if (e) {
        activate(v, cb)
      } else {
        log.info('download', v)
        dlAndInstall(v, cb)
      }
    })
  })
}

function latest(cb) {
  available_versions(function(err, versions) {
    if (err) {
      log.error('unable to get versions', err)
      process.exit(1)
    }
    var vers = versions[versions.length-1]
    return cb && cb(null, vers)
  })
}

function latest_stable(cb) {
  available_versions(function(err, versions) {
    if (err) {
      log.error('unable to get versions', err)
      process.exit(1)
    }
    var r = /[0-9]+\.[0-9]*[02468]\.[0-9]+/
    versions = versions.filter(function(v) {
      return r.test(v)
    })
    var vers = versions[versions.length-1]
    return cb && cb(null, vers)
  })
}

function dlAndInstall(v, cb) {
  var url = tarball_url(v)
  var out = fs.createWriteStream(path.join(tmp, v))
  var dir = path.join(VERSIONS_DIR, v)
  request.get(url)
         .pipe(zlib.createGunzip())
         .pipe(tar.Extract({
           path: dir,
           strip: 1
         }))
         .pipe(out)
  out.on('close', function() {
    log.verbose('download', 'complete')
    activate(v, cb)
  })
}

function activate(v, cb) {
  log.verbose('activate', v)
  if (v !== current_version()) {
    var dir = path.join(VERSIONS_DIR, v)
    var to = '/usr/local'
    fs.writeFileSync(prev, current_version())
    chain([
      [cp, path.join(dir, 'bin', 'node'), path.join(to, 'bin', 'node')]
    , [cp, path.join(dir, 'lib', 'dtrace'), path.join(to, 'lib', 'dtrace')]
    , [cp, path.join(dir, 'share'), path.join(to, 'share')]
    , parsed.npm && [cp, path.join(dir, 'bin', 'npm'), path.join(to, 'bin', 'npm')]
    ], cb)
  } else {
    log.verbose('activate', 'already active')
    cb && cb()
  }
}

function cp(from, to, cb) {
  ncp(from, to, cb)
}

function bin_path(v) {
  if (!v) {
    log.error('bin', 'version required')
    process.exit(1)
  }
  var node = path.join(VERSIONS_DIR, v, 'bin', 'node')
  if (fs.existsSync(node)) {
    console.log(node)
    return
  }
  log.error('bin', node)
}

function execute_with_version() {
  var args = Array.prototype.slice.call(arguments)
  var v = args[0]
  if (!v) {
    log.error('execute', 'version required')
    process.exit(1)
  }
  var node = path.join(VERSIONS_DIR, v, 'bin', 'node')
  log.verbose('node', node)
  args.shift()
  if (fs.existsSync(node)) {
    var child = spawn(node, args, {
      env: process.env,
      cwd: process.cwd()
    })
    child.stdout.pipe(process.stdout)
    child.stderr.pipe(process.stderr)
    child.on('exit', function(c) {
      process.exit(c)
    })
  } else {
    log.error('execute', 'version is not installed')
  }
}

function filter_versions(versions) {
  return versions.filter(function(version) {
    if (version.length > 4) {
      return +version[2] > 8 ||
             +version[2] === 8 &&
             +version[4] >= 6
    }
    return false
  })
}

function sort_versions(a,b) {
  a = a.split('.')
  b = b.split('.')
  return +a[0] < +b[0]
    ? -1
    : +a[0] > +b[0]
    ? 1
    : +a[1] < +b[1]
    ? -1
    : +a[1] > +b[1]
    ? 1
    : +a[2] < +b[2]
    ? -1
    : +a[2] > +b[2]
    ? 1
    : 0
}

if (parsed.stable) {
  return latest_stable(function(err, v) {
    install_node(v, function(err) {
      if (err) log.error('install', err)
      process.exit()
    })
  })
} else if (parsed.latest) {
  return latest(function(err, v) {
    install_node(v, function(err) {
      if (err) log.error('install', err)
      process.exit()
    })
  })
} else {
  var args = parsed.argv.remain
  if (!args.length) return help()

  switch (args[0]) {
    case 'bin':
    case 'which':
      bin_path(args[1])
      break
    case 'as':
    case 'use':
      args.shift()
      execute_with_version.apply(this, args)
      break
    case 'rm':
    case '-':
      break
    case 'latest':
      latest(function(err, v) {
        console.log(v)
      })
      break
    case 'stable':
      latest_stable(function(err, v) {
        console.log(v)
      })
      break
    case 'ls':
    case 'list':
      display_versions()
      break
  }
}
