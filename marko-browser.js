/*
GOAL: This module should mirror the NodeJS module system according the documented behavior.
The module transport will generate code that is used for resolving
real paths for a given logical path. This information is used to
resolve dependencies on client-side (in the browser).

Inspired by:
https://github.com/joyent/node/blob/master/lib/module.js
*/
(function() {
    var win = typeof window === 'undefined' ? null : window;

    if (win && win.$rmod) {
        return;
    }

    /** the module runtime */
    var $rmod;

    // this object stores the module factories with the keys being real paths of module (e.g. "/baz@3.0.0/lib/index" --> Function)
    var definitions = {};

    // Search path that will be checked when looking for modules
    var searchPaths = [];

    // The _ready flag is used to determine if "run" modules can
    // be executed or if they should be deferred until all dependencies
    // have been loaded
    var _ready = false;

    // If $rmod.run() is called when the page is not ready then
    // we queue up the run modules to be executed later
    var runQueue = [];

    // this object stores the Module instance cache with the keys being logical paths of modules (e.g., "/$/foo/$/baz" --> Module)
    var instanceCache = {};

    // this object maps dependency logical path to a specific version (for example, "/$/foo/$/baz" --> ["3.0.0"])
    // Each entry in the object is an array. The first item of the array is the version number of the dependency.
    // The second item of the array (if present), is the real dependency ID if the entry belongs to a remapping rule.
    // For example, with a remapping, an entry might look like:
    //      "/$/streams" => ["3.0.0", "streams-browser"]
    // An example with no remapping:
    //      "/$/streams" => ["3.0.0"]
    var dependencies = {};

    // this object maps relative paths to a specific real path
    var mains = {};

    // used to remap a real path to a new path (keys are real paths and values are relative paths)
    var remapped = {};

    var cacheByDirname = {};

    // When a module is mapped to a global varialble we add a reference
    // that maps the real path of the module to the loaded global instance.
    // We use this mapping to ensure that global modules are only loaded
    // once if they map to the same real path.
    //
    // See issue #5 - Ensure modules mapped to globals only load once
    // https://github.com/raptorjs/raptor-modules/issues/5
    var loadedGlobalsByRealPath = {};

    // temporary variable for referencing a prototype
    var proto;

    function moduleNotFoundError(target, from) {
        var err = new Error('Cannot find module "' + target + '"' + (from ? ' from "' + from + '"' : ''));

        err.code = 'MODULE_NOT_FOUND';
        return err;
    }

    function Module(resolved) {
       /*
        A Node module has these properties:
        - filename: The logical path of the module
        - id: The logical path of the module (same as filename)
        - exports: The exports provided during load
        - loaded: Has module been fully loaded (set to false until factory function returns)

        NOT SUPPORTED BY RAPTOR:
        - parent: parent Module
        - paths: The search path used by this module (NOTE: not documented in Node.js module system so we don't need support)
        - children: The modules that were required by this module
        */
        this.id = this.filename = resolved[0];
        this.loaded = false;
    }

    Module.cache = instanceCache;

    proto = Module.prototype;

    proto.load = function(factoryOrObject) {
        var logicalPath = this.id;

        if (factoryOrObject && factoryOrObject.constructor === Function) {
            // factoryOrObject is definitely a function
            var lastSlashPos = logicalPath.lastIndexOf('/');

            // find the value for the __dirname parameter to factory
            var dirname = logicalPath.substring(0, lastSlashPos);

            // find the value for the __filename paramter to factory
            var filename = logicalPath;

            // local cache for requires initiated from this module/dirname
            var localCache = cacheByDirname[dirname] || (cacheByDirname[dirname] = {});

            // this is the require used by the module
            var instanceRequire = function(target) {
                return localCache[target] || (localCache[target] = require(target, dirname));
            };

            // The require method should have a resolve method that will return logical
            // path but not actually instantiate the module.
            // This resolve function will make sure a definition exists for the corresponding
            // real path of the target but it will not instantiate a new instance of the target.
            instanceRequire.resolve = function(target) {
                if (!target) {
                    throw moduleNotFoundError('');
                }

                var resolved = resolve(target, dirname);

                if (!resolved) {
                    throw moduleNotFoundError(target, dirname);
                }

                // Return logical path
                // NOTE: resolved[0] is logical path
                return resolved[0];
            };

            // NodeJS provides access to the cache as a property of the "require" function
            instanceRequire.cache = instanceCache;

            // Expose the module system runtime via the `runtime` property
            instanceRequire.runtime = $rmod;

            // $rmod.def("/foo@1.0.0/lib/index", function(require, exports, module, __filename, __dirname) {
            this.exports = {};

            // call the factory function
            factoryOrObject.call(this, instanceRequire, this.exports, this, filename, dirname);
        } else {
            // factoryOrObject is not a function so have exports reference factoryOrObject
            this.exports = factoryOrObject;
        }

        this.loaded = true;
    };

    /**
     * Defines a packages whose metadata is used by raptor-loader to load the package.
     */
    function define(realPath, factoryOrObject, options) {
        /*
        $rmod.def('/baz@3.0.0/lib/index', function(require, exports, module, __filename, __dirname) {
            // module source code goes here
        });
        */

        var globals = options && options.globals;

        definitions[realPath] = factoryOrObject;

        if (globals) {
            var target = win || global;
            for (var i=0;i<globals.length; i++) {
                var globalVarName = globals[i];
                loadedGlobalsByRealPath[realPath] = target[globalVarName] = require(realPath, realPath);
            }
        }
    }

    function registerMain(realPath, relativePath) {
        mains[realPath] = relativePath;
    }

    function remap(oldRealPath, relativePath) {
        remapped[oldRealPath] = relativePath;
    }

    function registerDependency(logicalParentPath, dependencyId, dependencyVersion, dependencyAlsoKnownAs) {
        if (dependencyId === false) {
            // This module has been remapped to a "void" module (empty object) for the browser.
            // Add an entry in the dependencies, but use `null` as the value (handled differently from undefined)
            dependencies[logicalParentPath + '/$/' + dependencyAlsoKnownAs] = null;
            return;
        }

        var logicalPath = dependencyId.charAt(0) === '.' ?
            logicalParentPath + dependencyId.substring(1) : // Remove '.' at the beginning
            logicalParentPath + '/$/' + dependencyId;

        dependencies[logicalPath] =  [dependencyVersion];
        if (dependencyAlsoKnownAs !== undefined) {
            dependencies[logicalParentPath + '/$/' + dependencyAlsoKnownAs] =  [dependencyVersion, dependencyId, logicalPath];
        }
    }

    /**
     * This function will take an array of path parts and normalize them by handling handle ".." and "."
     * and then joining the resultant string.
     *
     * @param {Array} parts an array of parts that presumedly was split on the "/" character.
     */
    function normalizePathParts(parts) {

        // IMPORTANT: It is assumed that parts[0] === "" because this method is used to
        // join an absolute path to a relative path
        var i;
        var len = 0;

        var numParts = parts.length;

        for (i = 0; i < numParts; i++) {
            var part = parts[i];

            if (part === '.') {
                // ignore parts with just "."
                /*
                // if the "." is at end of parts (e.g. ["a", "b", "."]) then trim it off
                if (i === numParts - 1) {
                    //len--;
                }
                */
            } else if (part === '..') {
                // overwrite the previous item by decrementing length
                len--;
            } else {
                // add this part to result and increment length
                parts[len] = part;
                len++;
            }
        }

        if (len === 1) {
            // if we end up with just one part that is empty string
            // (which can happen if input is ["", "."]) then return
            // string with just the leading slash
            return '/';
        } else if (len > 2) {
            // parts i s
            // ["", "a", ""]
            // ["", "a", "b", ""]
            if (parts[len - 1].length === 0) {
                // last part is an empty string which would result in trailing slash
                len--;
            }
        }

        // truncate parts to remove unused
        parts.length = len;
        return parts.join('/');
    }

    function join(from, target) {
        var targetParts = target.split('/');
        var fromParts = from == '/' ? [''] : from.split('/');
        return normalizePathParts(fromParts.concat(targetParts));
    }

    function withoutExtension(path) {
        var lastDotPos = path.lastIndexOf('.');
        var lastSlashPos;

        /* jshint laxbreak:true */
        return ((lastDotPos === -1) || ((lastSlashPos = path.lastIndexOf('/')) !== -1) && (lastSlashPos > lastDotPos))
            ? null // use null to indicate that returned path is same as given path
            : path.substring(0, lastDotPos);
    }

    function truncate(str, length) {
        return str.substring(0, str.length - length);
    }

    /**
     * @param {String} logicalParentPath the path from which given dependencyId is required
     * @param {String} dependencyId the name of the module (e.g. "async") (NOTE: should not contain slashes)
     * @param {String} full version of the dependency that is required from given logical parent path
     */
    function versionedDependencyInfo(logicalPath, dependencyId, subpath, dependencyVersion) {
        // Our internal module resolver will return an array with the following properties:
        // - logicalPath: The logical path of the module (used for caching instances)
        // - realPath: The real path of the module (used for instantiating new instances via factory)
        var realPath = dependencyVersion && ('/' + dependencyId + '@' + dependencyVersion + subpath);
        logicalPath = logicalPath + subpath;

        // return [logicalPath, realPath, factoryOrObject]
        return [logicalPath, realPath, undefined];
    }

    function resolveAbsolute(target, origTarget) {
        var start = target.lastIndexOf('$');
        if (start === -1) {
            // return [logicalPath, realPath, factoryOrObject]
            return [target, target, undefined];
        }

        // target is something like "/$/foo/$/baz/lib/index"
        // In this example we need to find what version of "baz" foo requires

        // "start" is currently pointing to the last "$". We want to find the dependencyId
        // which will start after after the substring "$/" (so we increment by two)
        start += 2;

        // the "end" needs to point to the slash that follows the "$" (if there is one)
        var end = target.indexOf('/', start + 3);
        var logicalPath;
        var subpath;
        var dependencyId;

        if (end === -1) {
            // target is something like "/$/foo/$/baz" so there is no subpath after the dependencyId
            logicalPath = target;
            subpath = '';
            dependencyId = target.substring(start);
        } else {
            // Fixes https://github.com/raptorjs/raptor-modules/issues/15
            // Handle scoped packages where scope and package name are separated by a
            // forward slash (e.g. '@scope/package-name')
            //
            // In the case of scoped packages the dependencyId should be the combination of the scope
            // and the package name. Therefore if the target module begins with an '@' symbol then
            // skip past the first slash
            if (target.charAt(start) === '@') {
                end = target.indexOf('/', end+1);
            }

            // target is something like "/$/foo/$/baz/lib/index" so we need to separate subpath
            // from the dependencyId

            // logical path should not include the subpath
            logicalPath = target.substring(0, end);

            // subpath will be something like "/lib/index"
            subpath = target.substring(end);

            // dependencyId will be something like "baz" (will not contain slashes)
            dependencyId = target.substring(start, end);
        }

        // lookup the version
        var dependencyInfo = dependencies[logicalPath];
        if (dependencyInfo === undefined) {
            return undefined;
        }

        if (dependencyInfo === null) {
            // This dependency has been mapped to a void module (empty object). Return an empty
            // array as an indicator
            return [];
        }

        return versionedDependencyInfo(
            // dependencyInfo[2] is the logicalPath that the module should actually use
            // if it has been remapped. If dependencyInfo[2] is undefined then we haven't
            // found a remapped module and simply use the logicalPath that we checked
            dependencyInfo[2] || logicalPath,

            // realPath:
            // dependencyInfo[1] is the optional remapped dependency ID
            // (use the actual dependencyID from target if remapped dependency ID is undefined)
            dependencyInfo[1] || dependencyId,

            subpath,

            // first item is version number
            dependencyInfo[0]);
    }

    function resolveModule(target, from) {
        if (target.charAt(target.length-1) === '/') {
            // This is a hack because I found require('util/') in the wild and
            // it did not work because of the trailing slash
            target = target.slice(0, -1);
        }

        var len = searchPaths.length;
        for (var i = 0; i < len; i++) {
            // search path entries always end in "/";
            var candidate = searchPaths[i] + target;
            var resolved = resolve(candidate, from);
            if (resolved) {
                return resolved;
            }
        }

        var dependencyId;
        var subpath;

        var lastSlashPos = target.indexOf('/');

        // Fixes https://github.com/raptorjs/raptor-modules/issues/15
        // Handle scoped packages where scope and package name are separated by a
        // forward slash (e.g. '@scope/package-name')
        //
        // In the case of scoped packages the dependencyId should be the combination of the scope
        // and the package name. Therefore if the target module begins with an '@' symbol then
        // skip past the first slash
        if (lastSlashPos !== -1 && target.charAt(0) === '@') {
            lastSlashPos = target.indexOf('/', lastSlashPos+1);
        }

        if (lastSlashPos === -1) {
            dependencyId = target;
            subpath = '';
        } else {
            // When we're resolving a module, we don't care about the subpath at first
            dependencyId = target.substring(0, lastSlashPos);
            subpath = target.substring(lastSlashPos);
        }

        /*
        Consider when the module "baz" (which is a dependency of "foo") requires module "async":
        resolve('async', '/$/foo/$/baz');

        // TRY
        /$/foo/$/baz/$/async
        /$/foo/$/async
        /$/async

        // SKIP
        /$/foo/$/$/async
        /$/$/async
        */

        // First check to see if there is a sibling "$" with the given target
        // by adding "/$/<target>" to the given "from" path.
        // If the given from is "/$/foo/$/baz" then we will try "/$/foo/$/baz/$/async"
        var logicalPath = from + '/$/' + dependencyId;
        var dependencyInfo = dependencies[logicalPath];
        if (dependencyInfo !== undefined) {
            if (dependencyInfo === null) {
                // This dependency has been mapped to a void module (empty object). Return an empty
                // array as an indicator
                return [];
            }
            return versionedDependencyInfo(
                // dependencyInfo[2] is the logicalPath that the module should actually use
                // if it has been remapped. If dependencyInfo[2] is undefined then we haven't
                // found a remapped module and simply use the logicalPath that we checked
                dependencyInfo[2] || logicalPath,

                // dependencyInfo[1] is the optional remapped dependency ID
                // (use the actual dependencyID from target if remapped dependency ID is undefined)
                dependencyInfo[1] || dependencyId,

                subpath,

                // dependencyVersion
                dependencyInfo[0]);
        }

        var end = from.lastIndexOf('/');

        // if there is no "/" in the from path then this path is technically invalid (right?)
        while(end !== -1) {

            var start = -1;

            // make sure we don't check a logical path that would end with "/$/$/dependencyId"
            if (end > 0) {
                start = from.lastIndexOf('/', end - 1);
                if ((start !== -1) && (end - start === 2) && (from.charAt(start + 1) === '$')) {
                    // check to see if the substring from [start:end] is '/$/'
                    // skip look at this subpath because it ends with "/$/"
                    end = start;
                    continue;
                }
            }

            logicalPath = from.substring(0, end) + '/$/' + dependencyId;

            dependencyInfo = dependencies[logicalPath];
            if (dependencyInfo !== undefined) {
                if (dependencyInfo === null) {
                    return [];
                }

                return versionedDependencyInfo(
                    // dependencyInfo[2] is the logicalPath that the module should actually use
                    // if it has been remapped. If dependencyInfo[2] is undefined then we haven't
                    // found a remapped module and simply use the logicalPath that we checked
                    dependencyInfo[2] || logicalPath,

                    // dependencyInfo[1] is the optional remapped dependency ID
                    // (use the actual dependencyID from target if remapped dependency ID is undefined)
                    dependencyInfo[1] || dependencyId,

                    subpath,

                    // version number
                    dependencyInfo[0]);
            } else if (start === -1) {
                break;
            }

            // move end to the last slash that precedes it
            end = start;
        }

        // not found
        return undefined;
    }

    function resolve(target, from) {
        var resolved;
        var remappedPath;

        if (target.charAt(0) === '.') {
            // turn relative path into absolute path
            resolved = resolveAbsolute(join(from, target), target);
        } else if (target.charAt(0) === '/') {
            // handle targets such as "/my/file" or "/$/foo/$/baz"
            resolved = resolveAbsolute(normalizePathParts(target.split('/')));
        } else {
            remappedPath = remapped[target];
            if (remappedPath) {
                // The remapped path should be a complete logical path
                return resolve(remappedPath);
            } else {
                // handle targets such as "foo/lib/index"
                resolved = resolveModule(target, from);
            }
        }

        if (!resolved) {
            return undefined;
        }

        var logicalPath = resolved[0];
        var realPath = resolved[1];

        if (logicalPath === undefined) {
            // This dependency has been mapped to a void module (empty object).
            // Use a special '$' for logicalPath and realPath and an empty object for the factoryOrObject
            return ['$', '$', {}];
        }

        if (!realPath) {
            return resolve(logicalPath);
        }

        // target is something like "/foo/baz"
        // There is no installed module in the path
        var relativePath;

        // check to see if "target" is a "directory" which has a registered main file
        if ((relativePath = mains[realPath]) !== undefined) {
            // there is a main file corresponding to the given target so add the relative path
            logicalPath = join(logicalPath, relativePath);
            realPath = join(realPath, relativePath);
        }

        remappedPath = remapped[realPath];
        if (remappedPath !== undefined) {
            // remappedPath should be treated as a relative path
            logicalPath = join(logicalPath + '/..', remappedPath);
            realPath = join(realPath + '/..', remappedPath);
        }

        var factoryOrObject = definitions[realPath];
        if (factoryOrObject === undefined) {
            // check for definition for given realPath but without extension
            var realPathWithoutExtension;
            if (((realPathWithoutExtension = withoutExtension(realPath)) === null) ||
                ((factoryOrObject = definitions[realPathWithoutExtension]) === undefined)) {
                return undefined;
            }

            // we found the definition based on real path without extension so
            // update logical path and real path
            logicalPath = truncate(logicalPath, realPath.length - realPathWithoutExtension.length);
            realPath = realPathWithoutExtension;
        }

        // since we had to make sure a definition existed don't throw this away
        resolved[0] = logicalPath;
        resolved[1] = realPath;
        resolved[2] = factoryOrObject;

        return resolved;
    }

    function require(target, from) {
        if (!target) {
            throw moduleNotFoundError('');
        }

        var resolved = resolve(target, from);
        if (!resolved) {
            throw moduleNotFoundError(target, from);
        }

        var logicalPath = resolved[0];

        var module = instanceCache[logicalPath];

        if (module !== undefined) {
            // found cached entry based on the logical path
            return module.exports;
        }

        // Fixes issue #5 - Ensure modules mapped to globals only load once
        // https://github.com/raptorjs/raptor-modules/issues/5
        //
        // If a module is mapped to a global variable then we want to always
        // return that global instance of the module when it is being required
        // to avoid duplicate modules being loaded. For modules that are mapped
        // to global variables we also add an entry that maps the real path
        // of the module to the global instance of the loaded module.
        var realPath = resolved[1];
        if (loadedGlobalsByRealPath.hasOwnProperty(realPath)) {
            return loadedGlobalsByRealPath[realPath];
        }

        var factoryOrObject = resolved[2];

        module = new Module(resolved);

        // cache the instance before loading (allows support for circular dependency with partial loading)
        instanceCache[logicalPath] = module;

        module.load(factoryOrObject);

        return module.exports;
    }

    /*
    $rmod.run('/$/installed-module', '/src/foo');
    */
    function run(logicalPath, options) {
        var wait = !options || (options.wait !== false);
        if (wait && !_ready) {
            return runQueue.push([logicalPath, options]);
        }

        require(logicalPath, '/');
    }

    /*
     * Mark the page as being ready and execute any of the
     * run modules that were deferred
     */
    function ready() {
        _ready = true;

        var len;
        while((len = runQueue.length)) {
            // store a reference to the queue before we reset it
            var queue = runQueue;

            // clear out the queue
            runQueue = [];

            // run all of the current jobs
            for (var i = 0; i < len; i++) {
                var args = queue[i];
                run(args[0], args[1]);
            }

            // stop running jobs in the queue if we change to not ready
            if (!_ready) {
                break;
            }
        }
    }

    function addSearchPath(prefix) {
        searchPaths.push(prefix);
    }

    var pendingCount = 0;
    var onPendingComplete = function() {
        pendingCount--;
        if (!pendingCount) {
            // Trigger any "require-run" modules in the queue to run
            ready();
        }
    };

    /*
     * $rmod is the short-hand version that that the transport layer expects
     * to be in the browser window object
     */
    $rmod = {
        // "def" is used to define a module
        def: define,

        // "dep" is used to register a dependency (e.g. "/$/foo" depends on "baz")
        dep: registerDependency,
        run: run,
        main: registerMain,
        remap: remap,
        require: require,
        resolve: resolve,
        join: join,
        ready: ready,
        addSearchPath: addSearchPath,

        /**
         * Asynchronous bundle loaders should call `pending()` to instantiate
         * a new job. The object we return here has a `done` method that
         * should be called when the job completes. When the number of
         * pending jobs drops to 0, we invoke any of the require-run modules
         * that have been declared.
         */
        pending: function() {
            _ready = false;
            pendingCount++;
            return {
                done: onPendingComplete
            };
        }
    };

    if (win) {
        win.$rmod = $rmod;
    } else {
        module.exports = $rmod;
    }
})();

$rmod.def("/source", function(require, exports, module, __filename, __dirname) { var runtime = require('marko');
var compiler = require('marko/compiler');
var domready = require('domready');
var widgets = require('marko-widgets');

window.marko = {
    templates:{},
    defineComponent:widgets.defineComponent,
    ready:domready,
    compile:(name, src) {
        if(!name) {
            throw new Error('A name must be defined for this template');
        }

        if(name in window.marko.templates) {
            throw new Error('A template with that name has already been registered');
        }

        var compiledSrc = compiler.compile(replaceIncludes(src), name, null);
        var template = evalCommonJsTemplateSrc(name, compiledSrc);
        window.marko.templates[name] = template;
        return template;
    }
}

function replaceIncludes(src) {
    return src.replace(/<include\(("[^"]+"|'[^']+')\)/g, '<include(window.marko.templates[$1])');
}

function evalCommonJsTemplateSrc(name, src) {
    var wrappedSource = '(function(require, exports, module, __filename, __dirname) { ' + src + ' })';
    var factoryFunc = eval(wrappedSource);
    var templateExports = {};
    var templateModule = {
        require: require,
        exports: templateExports,
        id: name
    };

    factoryFunc(require, templateExports, templateModule, '/'+name+'.marko', '/');
    return templateModule.exports;
}

domready(function() {
    [].forEach.call(document.querySelectorAll('script[type*=marko]'), function(script) {
        var src = script.innerHTML;
        var name = script.getAttribute('name');

        if(!name) {
            if(window.console) {
                return console.error('One of your templates defined in a script tag is missing a name attribute');
            }
            return document.write('<div style="font-weight:bold;color:#900;">One of your templates defined in a script tag is missing a name attribute</div>');
        }

        window.marko.compile(name, src);
    });
});
});
$rmod.run("/source");
$rmod.main("/marko@3.3.0", "runtime/marko-runtime");
$rmod.dep("", "marko", "3.3.0");
$rmod.main("/async-writer@1.4.1", "lib/async-writer");
$rmod.dep("", "async-writer", "1.4.1");
$rmod.main("/process@0.6.0", "index");
$rmod.dep("", "process", "0.6.0");
$rmod.remap("/process@0.6.0/index", "browser");
$rmod.def("/process@0.6.0/browser", function(require, exports, module, __filename, __dirname) { // shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.once = noop;
process.off = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

});
$rmod.main("/events@1.1.0", "events");
$rmod.dep("", "events", "1.1.0");
$rmod.def("/events@1.1.0/events", function(require, exports, module, __filename, __dirname) { // Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      }
      throw TypeError('Uncaught, unspecified "error" event.');
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

});
$rmod.def("/async-writer@1.4.1/lib/AsyncWriter", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';var process=require("process"); 

function StringWriter(events) {
    this.str = '';
    this.events = events;
    this.finished = false;
}

StringWriter.prototype = {
    end: function() {
        this.finished = true;
        if (this.events) {
            this.events.emit('finish');
        }
    },

    write: function(str) {
        this.str += str;
        return this;
    },

    /**
     * Converts the string buffer into a String.
     *
     * @returns {String} The built String
     */
    toString: function() {
        return this.str;
    }
};

/**
 * Simple wrapper that can be used to wrap a stream
 * to reduce the number of write calls. In Node.js world,
 * each stream.write() becomes a chunk. We can avoid overhead
 * by reducing the number of chunks by buffering the output.
 */
function BufferedWriter(wrappedStream) {
    this._buffer = '';
    this._wrapped = wrappedStream;
}

BufferedWriter.prototype = {
    write: function(str) {
        this._buffer += str;
    },

    flush: function() {
        if (this._buffer.length !== 0) {
            this._wrapped.write(this._buffer);
            this._buffer = '';
            if (this._wrapped.flush) {
                this._wrapped.flush();
            }
        }
    },

    end: function() {
        this.flush();
        if(!this._wrapped.isTTY) {
            this._wrapped.end();
        }
    },
    on: function(event, callback) {
        return this._wrapped.on(event, callback);
    },
    once: function(event, callback) {
        return this._wrapped.once(event, callback);
    },

    clear: function() {
        this._buffer = '';
    }
};

var EventEmitter = require('/$/events'/*'events'*/).EventEmitter;

var includeStack = typeof process !== 'undefined' && process.env.NODE_ENV === 'development';

var voidWriter = {
    write: function() {}
};

function Fragment(asyncWriter) {
    this.asyncWriter = asyncWriter;
    // The asyncWriter that this async fragment is associated with
    this.writer = asyncWriter.writer;
    // The original writer this fragment was associated with
    this.finished = false;
    // Used to keep track if this async fragment was ended
    this.flushed = false;
    // Set to true when the contents of this async fragment have been
    // flushed to the original writer
    this.next = null;
    // A link to the next sibling async fragment (if any)
    this.ready = true;    // Will be set to true if this fragment is ready to be flushed
                          // (i.e. when there are no async fragments preceeding this fragment)
}
function flushNext(fragment, writer) {
    var next = fragment.next;
    if (next) {
        next.ready = true;
        // Since we have flushed the next fragment is ready
        next.writer = next.asyncWriter.writer = writer;
        // Update the next fragment to use the original writer
        next.flush();    // Now flush the next fragment (if it is not finish then it will just do nothing)
    }
}
function BufferedFragment(asyncWriter, buffer) {
    Fragment.call(this, asyncWriter);
    this.buffer = buffer;
}
BufferedFragment.prototype = {
    flush: function () {
        var writer = this.writer;
        var bufferedString = this.buffer.toString();

        if (bufferedString.length !== 0) {
            writer.write(bufferedString);
        }

        this.flushed = true;
        flushNext(this, writer);
    }
};

function AsyncFragment(asyncWriter) {
    Fragment.call(this, asyncWriter);
}

AsyncFragment.prototype = {
    end: function () {
        if (!this.finished) {
            // Make sure end is only called once by the user
            this.finished = true;

            if (this.ready) {
                // There are no nested asynchronous fragments that are
                // remaining and we are ready to be flushed then let's do it!
                this.flush();
            }
        }
    },
    flush: function () {
        if (!this.finished) {
            // Skipped Flushing since not finished
            return;
        }
        this.flushed = true;
        var writer = this.writer;
        this.writer = this.asyncWriter.writer = voidWriter; // Prevent additional out-of-order writes
        flushNext(this, writer);
    }
};

function AsyncWriter(writer, global, async, buffer) {
    this.data = {};
    this.global = this.attributes /* legacy */ = (global || (global = {}));
    this._af = this._prevAF = this._parentAF = null;
    this._isSync = false;
    this._last = null;

    if (!global.events) {
        // Use the underlying stream as the event emitter if available.
        // Otherwise, create a new event emitter
        global.events = writer && writer.on ? writer : new EventEmitter();
    }

    this._events = global.events;

    if (async) {
        this._async = async;
    } else {
        this._async = global.async || (global.async = {
            remaining: 0,
            ended: false,
            last: 0,
            finished: false
        });
    }

    var stream;

    if (!writer) {
        writer = new StringWriter(this._events);
    } else if (buffer) {
        stream = writer;
        writer = new BufferedWriter(writer);
    }

    this.stream = stream || writer;
    this.writer = this._stream = writer;
}

AsyncWriter.DEFAULT_TIMEOUT = 10000;

AsyncWriter.prototype = {
    constructor: AsyncWriter,

    isAsyncWriter: AsyncWriter,

    sync: function() {
        this._isSync = true;
    },
    getAttributes: function () {
        return this.global;
    },
    getAttribute: function (name) {
        return this.global[name];
    },
    write: function (str) {
        if (str != null) {
            this.writer.write(str.toString());
        }
        return this;
    },
    getOutput: function () {
        return this.writer.toString();
    },
    captureString: function (func, thisObj) {
        var sb = new StringWriter();
        this.swapWriter(sb, func, thisObj);
        return sb.toString();
    },
    swapWriter: function (newWriter, func, thisObj) {
        var oldWriter = this.writer;
        this.writer = newWriter;
        func.call(thisObj);
        this.writer = oldWriter;
    },
    createNestedWriter: function (writer) {
        var _this = this;
        var child = new AsyncWriter(writer, _this.global);
        // Keep a reference to the original stream. This was done because when
        // rendering to a response stream we can get access to the request/response
        // to figure out the locale and other information associated with the
        // client. Without this we would have to rely on the request being
        // passed around everywhere or rely on something like continuation-local-storage
        // which has shown to be unreliable in some situations.
        child._stream = _this._stream; // This is the original stream or the stream wrapped with a BufferedWriter
        child.stream = _this.stream; // HACK: This is the user assigned stream and not the stream
                                     //       that was wrapped with a BufferedWriter.
        return child;
    },
    beginAsync: function (options) {
        if (this._isSync) {
            throw new Error('beginAsync() not allowed when using renderSync()');
        }

        var ready = true;

        // Create a new asyncWriter that the async fragment can write to.
        // The new async asyncWriter will use the existing writer and
        // the writer for the current asyncWriter (which will continue to be used)
        // will be replaced with a string buffer writer
        var asyncOut = this.createNestedWriter(this.writer);
        var buffer = this.writer = new StringWriter();
        var asyncFragment = new AsyncFragment(asyncOut);
        var bufferedFragment = new BufferedFragment(this, buffer);
        asyncFragment.next = bufferedFragment;
        asyncOut._af = asyncFragment;
        asyncOut._parentAF = asyncFragment;
        var prevAsyncFragment = this._prevAF || this._parentAF;
        // See if we are being buffered by a previous asynchronous
        // fragment
        if (prevAsyncFragment) {
            // Splice in our two new fragments and add a link to the previous async fragment
            // so that it can let us know when we are ready to be flushed
            bufferedFragment.next = prevAsyncFragment.next;
            prevAsyncFragment.next = asyncFragment;
            if (!prevAsyncFragment.flushed) {
                ready = false;    // If we are preceeded by another async fragment then we aren't ready to be flushed
            }
        }
        asyncFragment.ready = ready;
        // Set the ready flag based on our earlier checks above
        this._prevAF = bufferedFragment;
        // Record the previous async fragment for linking purposes


        asyncOut.handleBeginAsync(options, this);

        return asyncOut;
    },

    handleBeginAsync: function(options, parent) {
        var _this = this;

        var async = _this._async;

        var timeout;
        var name;

        async.remaining++;

        if (options != null) {
            if (typeof options === 'number') {
                timeout = options;
            } else {
                timeout = options.timeout;

                if (options.last === true) {
                    if (timeout == null) {
                        // Don't assign a timeout to last flush fragments
                        // unless it is explicitly given a timeout
                        timeout = 0;
                    }

                    async.last++;
                }

                name = options.name;
            }
        }

        if (timeout == null) {
            timeout = AsyncWriter.DEFAULT_TIMEOUT;
        }

        _this.stack = includeStack ? new Error().stack : null;
        _this.name = name;

        if (timeout > 0) {
            _this._timeoutId = setTimeout(function() {
                _this.error(new Error('Async fragment ' + (name ? '(' + name + ') ': '') + 'timed out after ' + timeout + 'ms'));
            }, timeout);
        }

        this._events.emit('beginAsync', {
            writer: this,
            parentWriter: parent
        });
    },
    on: function(event, callback) {
        if (event === 'finish' && this.writer.finished) {
            callback();
            return this;
        }

        this._events.on(event, callback);
        return this;
    },

    once: function(event, callback) {
        if (event === 'finish' && this.writer.finished) {
            callback();
            return this;
        }

        this._events.once(event, callback);
        return this;
    },

    onLast: function(callback) {
        var lastArray = this._last;

        if (!lastArray) {
            lastArray = this._last = [];
            var i = 0;
            var next = function next() {
                if (i === lastArray.length) {
                    return;
                }
                var _next = lastArray[i++];
                _next(next);
            };

            this.once('last', function() {
                next();
            });
        }

        lastArray.push(callback);
    },

    emit: function(arg) {
        var events = this._events;
        switch(arguments.length) {
            case 0:
                events.emit();
                break;
            case 1:
                events.emit(arg);
                break;
            default:
                events.emit.apply(events, arguments);
                break;
        }

        return this;
    },

    removeListener: function() {
        var events = this._events;
        events.removeListener.apply(events, arguments);
        return this;
    },

    pipe: function(stream) {
        this._stream.pipe(stream);
        return this;
    },

    error: function(e) {
        try {
            var stack = this.stack;
            var name = this.name;
            e = new Error('Async fragment failed' + (name ? ' (' + name + ')': '') + '. Exception: ' + (e.stack || e) + (stack ? ('\nCreation stack trace: ' + stack) : ''));
            this.emit('error', e);
        } finally {
             this.end();
        }
    },

    end: function(data) {
        if (data) {
            this.write(data);
        }

        var asyncFragment = this._af;

        if (asyncFragment) {
            asyncFragment.end();
            this.handleEnd(true);
        } else {
            this.handleEnd(false);
        }

        return this;
    },

    handleEnd: function(isAsync) {
        var async = this._async;


        if (async.finished) {
            return;
        }

        var remaining;

        if (isAsync) {
            var timeoutId = this._timeoutId;
            if (timeoutId) {
                clearTimeout(timeoutId);
            }

            remaining = --async.remaining;
        } else {
            remaining = async.remaining;
            async.ended = true;
        }

        if (async.ended) {
            if (!async.lastFired && async.remaining - async.last === 0) {
                async.lastFired = true;
                async.last = 0;
                this._events.emit('last');
            }

            if (remaining === 0) {
                async.finished = true;
                this._finish();
            }
        }
    },

    _finish: function() {
        if (this._stream.end) {
            this._stream.end();
        } else {
            this._events.emit('finish');
        }
    },

    flush: function() {
        if (!this._async.finished) {
            var stream = this._stream;
            if (stream && stream.flush) {
                stream.flush();
            }
        }
    }
};

AsyncWriter.prototype.w = AsyncWriter.prototype.write;

AsyncWriter.enableAsyncStackTrace = function() {
    includeStack = true;
};

module.exports = AsyncWriter;

});
$rmod.def("/async-writer@1.4.1/lib/async-writer", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * This module provides the runtime for rendering compiled templates.
 *
 *
 * <p>The code for the Marko compiler is kept separately
 * in the {@link raptor/templating/compiler} module.
 */
'use strict';

var AsyncWriter = require('./AsyncWriter');

exports.create = function (writer, options) {
    var global;
    var buffer;

    if (options) {
        global = options.global;
        buffer = options.buffer === true;
    }

    var asyncWriter = new AsyncWriter(writer, null, null, buffer);    //Create a new context using the writer provided
    if (global) {
        asyncWriter.global = asyncWriter.attributes = global;
    }
    return asyncWriter;
};

exports.enableAsyncStackTrace = function() {
    AsyncWriter.INCLUDE_STACK = true;
};

exports.AsyncWriter = AsyncWriter;

});
$rmod.dep("", "raptor-util", "1.0.10");
$rmod.def("/raptor-util@1.0.10/escapeXml", function(require, exports, module, __filename, __dirname) { var elTest = /[&<]/;
var elTestReplace = /[&<]/g;
var attrTest = /[&<>\"\'\n]/;
var attrReplace = /[&<>\"\'\n]/g;
var replacements = {
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    '\'': '&#39;',
    '\n': '&#10;' //Preserve new lines so that they don't get normalized as space
};

function replaceChar(match) {
    return replacements[match];
}

function escapeXml(str) {
    // check for most common case first
    if (typeof str === 'string') {
        return elTest.test(str) ? str.replace(elTestReplace, replaceChar) : str;
    }

    return (str == null) ? '' : str.toString();
}

function escapeXmlAttr(str) {
    if (typeof str === 'string') {
        return attrTest.test(str) ? str.replace(attrReplace, replaceChar) : str;
    }

    return (str == null) ? '' : str.toString();
}


module.exports = escapeXml;
escapeXml.attr = escapeXmlAttr;
});
$rmod.main("/marko@3.3.0/runtime", "marko-runtime");
$rmod.def("/raptor-util@1.0.10/attr", function(require, exports, module, __filename, __dirname) { var escapeXmlAttr = require('./escapeXml').attr;

module.exports = function(name, value, escapeXml) {
    if (value === true) {
        value = '';
    } else if (value == null || value === '' || value === false) {
        return '';
    } else {
        value = '="' + (escapeXml === false ? value : escapeXmlAttr(value)) + '"';
    }
    return ' ' + name + value;
};
});
$rmod.def("/marko@3.3.0/runtime/helpers", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

'use strict';
var escapeXml = require('/$/raptor-util/escapeXml'/*'raptor-util/escapeXml'*/);
var escapeXmlAttr = escapeXml.attr;
var runtime = require('./'); // Circular dependency, but that is okay
var attr = require('/$/raptor-util/attr'/*'raptor-util/attr'*/);
var isArray = Array.isArray;
var STYLE_ATTR = 'style';
var CLASS_ATTR = 'class';

function notEmpty(o) {
    if (o == null) {
        return false;
    } else if (Array.isArray(o)) {
        return !!o.length;
    } else if (o === '') {
        return false;
    }

    return true;
}

function classListHelper(arg, classNames) {
    var len;

    if (arg) {
        if (typeof arg === 'string') {
            classNames.push(arg);
        } else if (typeof (len = arg.length) === 'number') {
            for (var i=0; i<len; i++) {
                classListHelper(arg[i], classNames);
            }
        } else if (typeof arg === 'object') {
            for (var name in arg) {
                if (arg.hasOwnProperty(name)) {
                    var value = arg[name];
                    if (value) {
                        classNames.push(name);
                    }
                }
            }
        }
    }
}

function classList(classList) {
    var classNames = [];
    classListHelper(classList, classNames);
    return classNames.join(' ');
}

function createDeferredRenderer(handler) {
    function deferredRenderer(input, out) {
        deferredRenderer.renderer(input, out);
    }

    // This is the initial function that will do the rendering. We replace
    // the renderer with the actual renderer func on the first render
    deferredRenderer.renderer = function(input, out) {
        var rendererFunc = handler.renderer || handler.render;
        if (typeof rendererFunc !== 'function') {
            throw new Error('Invalid tag handler: ' + handler);
        }
        // Use the actual renderer from now on
        deferredRenderer.renderer = rendererFunc;
        rendererFunc(input, out);
    };

    return deferredRenderer;
}

function resolveRenderer(handler) {
    var renderer = handler.renderer;

    if (renderer) {
        return renderer;
    }

    if (typeof handler === 'function') {
        return handler;
    }

    if (typeof (renderer = handler.render) === 'function') {
        return renderer;
    }

    // If the user code has a circular function then the renderer function
    // may not be available on the module. Since we can't get a reference
    // to the actual renderer(input, out) function right now we lazily
    // try to get access to it later.
    return createDeferredRenderer(handler);
}

module.exports = {
    /**
     * Internal helper method to prevent null/undefined from being written out
     * when writing text that resolves to null/undefined
     * @private
     */
    s: function(str) {
        return (str == null) ? '' : str;
    },
    /**
     * Internal helper method to handle loops with a status variable
     * @private
     */
    fv: function (array, callback) {
        if (!array) {
            return;
        }
        if (!array.forEach) {
            array = [array];
        }
        var i = 0;
        var len = array.length;
        var loopStatus = {
                getLength: function () {
                    return len;
                },
                isLast: function () {
                    return i === len - 1;
                },
                isFirst: function () {
                    return i === 0;
                },
                getIndex: function () {
                    return i;
                }
            };
        for (; i < len; i++) {
            var o = array[i];
            callback(o, loopStatus);
        }
    },
    /**
     * Internal helper method to handle loops without a status variable
     * @private
     */
    f: function forEach(array, callback) {
        if (isArray(array)) {
            for (var i=0; i<array.length; i++) {
                callback(array[i]);
            }
        } else if (typeof array === 'function') {
            // Also allow the first argument to be a custom iterator function
            array(callback);
        }
    },
    /**
     * Internal helper method for looping over the properties of any object
     * @private
     */
    fp: function (o, func) {
        if (!o) {
            return;
        }
        for (var k in o) {
            if (o.hasOwnProperty(k)) {
                func(k, o[k]);
            }
        }
    },
    /**
     * Internal method to check if an object/array is empty
     * @private
     */
    e: function (o) {
        return !notEmpty(o);
    },
    /**
     * Internal method to check if an object/array is not empty
     * @private
     */
    ne: notEmpty,
    /**
     * Internal method to escape special XML characters
     * @private
     */
    x: escapeXml,
    /**
     * Internal method to escape special XML characters within an attribute
     * @private
     */
    xa: escapeXmlAttr,
    /**
     * Internal method to render a single HTML attribute
     * @private
     */
    a: attr,

    /**
     * Internal method to render multiple HTML attributes based on the properties of an object
     * @private
     */
    as: function(arg) {
        if (typeof arg === 'object') {
            var out = '';
            for (var attrName in arg) {
                out += attr(attrName, arg[attrName]);
            }
            return out;
        } else if (typeof arg === 'string') {
            return arg;
        }
        return '';
    },

    /**
     * Internal helper method to handle the "style" attribute. The value can either
     * be a string or an object with style propertes. For example:
     *
     * sa('color: red; font-weight: bold') ==> ' style="color: red; font-weight: bold"'
     * sa({color: 'red', 'font-weight': 'bold'}) ==> ' style="color: red; font-weight: bold"'
     */
    sa: function(style) {
        if (!style) {
            return '';
        }

        if (typeof style === 'string') {
            return attr(STYLE_ATTR, style, false);
        } else if (typeof style === 'object') {
            var parts = [];
            for (var name in style) {
                if (style.hasOwnProperty(name)) {
                    var value = style[name];
                    if (value) {
                        parts.push(name + ':' + value);
                    }
                }
            }
            return parts ? attr(STYLE_ATTR, parts.join(';'), false) : '';
        } else {
            return '';
        }
    },

    /**
     * Internal helper method to handle the "class" attribute. The value can either
     * be a string, an array or an object. For example:
     *
     * ca('foo bar') ==> ' class="foo bar"'
     * ca({foo: true, bar: false, baz: true}) ==> ' class="foo baz"'
     * ca(['foo', 'bar']) ==> ' class="foo bar"'
     */
    ca: function(classNames) {
        if (!classNames) {
            return '';
        }

        if (typeof classNames === 'string') {
            return attr(CLASS_ATTR, classNames, false);
        } else {
            return attr(CLASS_ATTR, classList(classNames), false);
        }
    },

    /**
     * Loads a template (__helpers.l --> loadTemplate(path))
     */
    l: function(path) {
        if (typeof path === 'string') {
            return runtime.load(path);
        } else {
            // Assume it is already a pre-loaded template
            return path;
        }
    },

    // ----------------------------------
    // The helpers listed below require an out
    // ----------------------------------


    /**
     * Invoke a tag handler render function
     */
    t: function (renderer, targetProperty, isRepeated, hasNestedTags) {
        if (renderer) {
            renderer = resolveRenderer(renderer);
        }

        if (targetProperty || hasNestedTags) {
            return function(input, out, parent, renderBody) {
                // Handle nested tags
                if (renderBody) {
                    renderBody(out, input);
                }

                if (targetProperty) {
                    // If we are nested tag then we do not have a renderer
                    if (isRepeated) {
                        var existingArray = parent[targetProperty];
                        if (existingArray) {
                            existingArray.push(input);
                        } else {
                            parent[targetProperty] = [input];
                        }
                    } else {
                        parent[targetProperty] = input;
                    }
                } else {
                    // We are a tag with nested tags, but we have already found
                    // our nested tags by rendering the body
                    renderer(input, out);
                }
            };
        } else {
            return renderer;
        }
    },

    /**
     * Internal method to handle includes/partials
     * @private
     */
    i: function(out, template, data) {
        if (!template) {
            return;
        }

        if (typeof template.render === 'function') {
            template.render(data, out);
        } else {
            throw new Error('Invalid template: ' + template);
        }

        return this;
    },

    /**
     * Merges object properties
     * @param  {[type]} object [description]
     * @param  {[type]} source [description]
     * @return {[type]}        [description]
     */
    m: function(into, source) {
        for (var k in source) {
            if (source.hasOwnProperty(k) && !into.hasOwnProperty(k)) {
                into[k] = source[k];
            }
        }
        return into;
    },

    /**
     * classList(a, b, c, ...)
     * Joines a list of class names with spaces. Empty class names are omitted.
     *
     * classList('a', undefined, 'b') --> 'a b'
     *
     */
    cl: function() {
        return classList(arguments);
    }
};

});
$rmod.def("/raptor-util@1.0.10/extend", function(require, exports, module, __filename, __dirname) { module.exports = function extend(target, source) { //A simple function to copy properties from one object to another
    if (!target) { //Check if a target was provided, otherwise create a new empty object to return
        target = {};
    }

    if (source) {
        for (var propName in source) {
            if (source.hasOwnProperty(propName)) { //Only look at source properties that are not inherited
                target[propName] = source[propName]; //Copy the property
            }
        }
    }

    return target;
};
});
$rmod.def("/raptor-util@1.0.10/inherit", function(require, exports, module, __filename, __dirname) { var extend = require('./extend');

function _inherit(clazz, superclass, copyProps) { //Helper function to setup the prototype chain of a class to inherit from another class's prototype
    
    var proto = clazz.prototype;
    var F = function() {};
    
    F.prototype = superclass.prototype;

    clazz.prototype = new F();
    clazz.$super = superclass;

    if (copyProps !== false) {
        extend(clazz.prototype, proto);
    }

    clazz.prototype.constructor = clazz;
    return clazz;
}

function inherit(clazz, superclass) {
    return _inherit(clazz, superclass, true);
}


module.exports = inherit;

inherit._inherit = _inherit;
});
$rmod.remap("/marko@3.3.0/runtime/loader", "loader_browser");
$rmod.def("/marko@3.3.0/runtime/loader_browser", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
* 
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
* 
*    http://www.apache.org/licenses/LICENSE-2.0
* 
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

module.exports = function load(templatePath) {
    // We make the assumption that the template path is a 
    // fully resolved module path and that the module exists
    // as a CommonJS module
    return require(templatePath);
};
});
$rmod.def("/marko@3.3.0/runtime/marko-runtime", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * This module provides the lightweight runtime for loading and rendering
 * templates. The compilation is handled by code that is part of the
 * [marko/compiler](https://github.com/raptorjs/marko/tree/master/compiler)
 * module. If rendering a template on the client, only the runtime is needed
 * on the client and not the compiler
 */

// async-writer provides all of the magic to support asynchronous
// rendering to a stream

'use strict';
/**
 * Method is for internal usage only. This method
 * is invoked by code in a compiled Marko template and
 * it is used to create a new Template instance.
 * @private
 */
exports.c = function createTemplate(path) {
    return new Template(path);
};

var BUFFER_OPTIONS = { buffer: true };

var asyncWriter = require('/$/async-writer'/*'async-writer'*/);

// helpers provide a core set of various utility methods
// that are available in every template (empty, notEmpty, etc.)
var helpers = require('./helpers');

var loader;

// If the optional "stream" module is available
// then Readable will be a readable stream
var Readable;

var AsyncWriter = asyncWriter.AsyncWriter;
var extend = require('/$/raptor-util/extend'/*'raptor-util/extend'*/);



exports.AsyncWriter = AsyncWriter;

var stream;
var STREAM = 'stream';

var streamPath;
try {
    streamPath = require.resolve(STREAM);
} catch(e) {}

if (streamPath) {
    stream = require(streamPath);
}

function renderCallback(renderFunc, data, globalData, callback) {
    var out = new AsyncWriter();
    if (globalData) {
        extend(out.global, globalData);
    }

    renderFunc(data, out);
    return out.end()
        .on('finish', function() {
            callback(null, out.getOutput(), out);
        })
        .once('error', callback);
}

function Template(path, func, options) {
    this.path = path;
    this._ = func;
    this._options = !options || options.buffer !== false ?
        BUFFER_OPTIONS : null;
}

Template.prototype = {
    /**
     * Internal method to initialize a loaded template with a
     * given create function that was generated by the compiler.
     * Warning: User code should not depend on this method.
     *
     * @private
     * @param  {Function(__helpers)} createFunc The function used to produce the render(data, out) function.
     */
    c: function(createFunc) {
        this._ = createFunc(helpers);
    },
    renderSync: function(data) {
        var localData = data || {};
        var out = new AsyncWriter();
        out.sync();

        if (localData.$global) {
            out.global = extend(out.global, localData.$global);
            delete localData.$global;
        }

        this._(localData, out);
        return out.getOutput();
    },

    /**
     * Renders a template to either a stream (if the last
     * argument is a Stream instance) or
     * provides the output to a callback function (if the last
     * argument is a Function).
     *
     * Supported signatures:
     *
     * render(data, callback)
     * render(data, out)
     * render(data, stream)
     * render(data, out, callback)
     * render(data, stream, callback)
     *
     * @param  {Object} data The view model data for the template
     * @param  {AsyncWriter} out A Stream or an AsyncWriter instance
     * @param  {Function} callback A callback function
     * @return {AsyncWriter} Returns the AsyncWriter instance that the template is rendered to
     */
    render: function(data, out, callback) {
        var renderFunc = this._;
        var finalData;
        var globalData;
        if (data) {
            finalData = data;

            if ((globalData = data.$global)) {
                // We will *move* the "$global" property
                // into the "out.global" object
                delete data.$global;
            }
        } else {
            finalData = {};
        }

        if (typeof out === 'function') {
            // Short circuit for render(data, callback)
            return renderCallback(renderFunc, finalData, globalData, out);
        }

        // NOTE: We create new vars here to avoid a V8 de-optimization due
        //       to the following:
        //       Assignment to parameter in arguments object
        var finalOut = out;

        var shouldEnd = false;

        if (arguments.length === 3) {
            // render(data, out, callback)
            if (!finalOut || !finalOut.isAsyncWriter) {
                finalOut = new AsyncWriter(finalOut);
                shouldEnd = true;
            }

            finalOut
                .on('finish', function() {
                    callback(null, finalOut.getOutput(), finalOut);
                })
                .once('error', callback);
        } else if (!finalOut || !finalOut.isAsyncWriter) {
            // Assume the "finalOut" is really a stream
            //
            // By default, we will buffer rendering to a stream to prevent
            // the response from being "too chunky".
            finalOut = asyncWriter.create(finalOut, this._options);
            shouldEnd = true;
        }

        if (globalData) {
            extend(finalOut.global, globalData);
        }

        // Invoke the compiled template's render function to have it
        // write out strings to the provided out.
        renderFunc(finalData, finalOut);

        // Automatically end output stream (the writer) if we
        // had to create an async writer (which might happen
        // if the caller did not provide a writer/out or the
        // writer/out was not an AsyncWriter).
        //
        // If out parameter was originally an AsyncWriter then
        // we assume that we are writing to output that was
        // created in the context of another rendering job.
        return shouldEnd ? finalOut.end() : finalOut;
    },
    stream: function(data) {
        if (!stream) {
            throw new Error('Module not found: stream');
        }

        return new Readable(this, data, this._options);
    }
};

if (stream) {
    Readable = function(template, data, options) {
        Readable.$super.call(this);
        this._t = template;
        this._d = data;
        this._options = options;
        this._rendered = false;
    };

    Readable.prototype = {
        write: function(data) {
            if (data != null) {
                this.push(data);
            }
        },
        end: function() {
            this.push(null);
        },
        _read: function() {
            if (this._rendered) {
                return;
            }

            this._rendered = true;

            var template = this._t;
            var data = this._d;

            var out = asyncWriter.create(this, this._options);
            template.render(data, out);
            out.end();
        }
    };

    require('/$/raptor-util/inherit'/*'raptor-util/inherit'*/)(Readable, stream.Readable);
}

function createRenderProxy(template) {
    return function(data, out) {
        template._(data, out);
    };
}

function initTemplate(rawTemplate, templatePath) {
    if (rawTemplate.render) {
        return rawTemplate;
    }

    var createFunc = rawTemplate.create || rawTemplate;

    var template = createFunc.loaded;
    if (!template) {
        template = createFunc.loaded = new Template(templatePath);
        template.c(createFunc);
    }
    return template;
}

function load(templatePath, templateSrc, options) {
    if (!templatePath) {
        throw new Error('"templatePath" is required');
    }

    if (arguments.length === 1) {
        // templateSrc and options not provided
    } else if (arguments.length === 2) {
        // see if second argument is templateSrc (a String)
        // or options (an Object)
        var lastArg = arguments[arguments.length - 1];
        if (typeof lastArg !== 'string') {
            options = arguments[1];
            templateSrc = undefined;
        }
    } else if (arguments.length === 3) {
        // assume function called according to function signature
    } else {
        throw new Error('Illegal arguments');
    }

    var template;

    if (typeof templatePath === 'string') {
        template = initTemplate(loader(templatePath, templateSrc, options), templatePath);
    } else if (templatePath.render) {
        template = templatePath;
    } else {
        template = initTemplate(templatePath);
    }

    if (options && (options.buffer != null)) {
        template = new Template(
            template.path,
            createRenderProxy(template),
            options);
    }

    return template;
}

exports.load = load;

exports.createWriter = function(writer) {
    return new AsyncWriter(writer);
};

exports.helpers = helpers;

exports.Template = Template;

// The loader is used to load templates that have not already been
// loaded and cached. On the server, the loader will use
// the compiler to compile the template and then load the generated
// module file using the Node.js module loader
loader = require('./loader');

});
$rmod.main("/marko@3.3.0/compiler", "index");
$rmod.def("/marko@3.3.0/taglibs/async/async-fragment-nested-tag-transformer", function(require, exports, module, __filename, __dirname) { 'use strict';

module.exports = function transform(el, context) {
    var parentNode = el.parentNode;

    if (parentNode.tagName !== 'async-fragment') {
        context.addError(el, 'The <' + el.tagName + '> should be nested within an <async-fragment> tag.');
        return;
    }

    var targetProp;

    if (el.tagName === 'async-fragment-error') {
        targetProp = 'renderError';
    } else if (el.tagName === 'async-fragment-timeout') {
        targetProp = 'renderTimeout';
    } else if (el.tagName === 'async-fragment-placeholder') {
        targetProp = 'renderPlaceholder';
    }

    var builder = context.builder;

    parentNode.setAttributeValue(targetProp, builder.renderBodyFunction(el.body));
    el.detach();
};

});
$rmod.def("/raptor-util@1.0.10/isObjectEmpty", function(require, exports, module, __filename, __dirname) { module.exports = function isObjectEmpty(o) {
    if (!o) {
        return true;
    }
    
    for (var k in o) {
        if (o.hasOwnProperty(k)) {
            return false;
        }
    }
    return true;
};
});
$rmod.def("/marko@3.3.0/taglibs/async/async-fragment-tag-transformer", function(require, exports, module, __filename, __dirname) { 'use strict';

var isObjectEmpty = require('/$/raptor-util/isObjectEmpty'/*'raptor-util/isObjectEmpty'*/);

module.exports = function transform(el, context) {
    var varName = el.getAttributeValue('var');
    if (varName) {
        if (varName.type !== 'Literal' || typeof varName.value !== 'string') {
            context.addError(el, 'The "var" attribute value should be a string');
            return;
        }

        varName = varName.value;

        if (!context.util.isValidJavaScriptIdentifier(varName)) {
            context.addError(el, 'The "var" attribute value should be a valid JavaScript identifier');
            return;
        }
    } else {
        context.addError(el, 'The "var" attribute is required');
        return;
    }

    var attrs = el.getAttributes().concat([]);
    var arg = {};
    var builder = context.builder;

    attrs.forEach((attr) => {
        var attrName = attr.name;
        if (attrName.startsWith('arg-')) {
            let argName = attrName.substring('arg-'.length);
            arg[argName] = attr.value;
            el.removeAttribute(attrName);
        }
    });

    var dataProviderAttr = el.getAttribute('data-provider');
    if (!dataProviderAttr) {
        context.addError(el, 'The "data-provider" attribute is required');
        return;
    }

    if (dataProviderAttr.value == null) {
        context.addError(el, 'A value is required for the "data-provider" attribute');
        return;
    }

    if (dataProviderAttr.value.type == 'Literal') {
        context.addError(el, 'The "data-provider" attribute value should not be a literal ' + (typeof dataProviderAttr.value.value));
        return;
    }

    var name = el.getAttributeValue('name');
    if (name == null) {
        el.setAttributeValue('_name', builder.literal(dataProviderAttr.rawValue));
    }

    if (el.hasAttribute('arg')) {
        if (isObjectEmpty(arg)) {
            arg = el.getAttributeValue('arg');
        } else {
            let mergeVar = context.addStaticVar('__merge', '__helpers.m');
            arg = builder.functionCall(mergeVar, [
                builder.literal(arg), // Input props from the attributes take precedence
                el.getAttributeValue('arg')
            ]);
        }
    } else {
        if (isObjectEmpty(arg)) {
            arg = null;
        } else {
            arg = builder.literal(arg);
        }
    }

    if (arg) {
        el.setAttributeValue('arg', arg);
    }

    var timeoutMessage = el.getAttributeValue('timeout-message');
    if (timeoutMessage) {
        el.removeAttribute('timeout-message');
        el.setAttributeValue('renderTimeout', builder.renderBodyFunction([
            builder.text(timeoutMessage)
        ]));
    }

    var errorMessage = el.getAttributeValue('error-message');
    if (errorMessage) {
        el.removeAttribute('error-message');
        el.setAttributeValue('renderError', builder.renderBodyFunction([
            builder.text(errorMessage)
        ]));
    }

    var placeholder = el.getAttributeValue('placeholder');
    if (placeholder) {
        el.removeAttribute('placeholder');
        el.setAttributeValue('renderPlaceholder', builder.renderBodyFunction([
            builder.text(placeholder)
        ]));
    }
};

});
$rmod.main("/raptor-logging@1.1.1", "lib/index");
$rmod.dep("", "raptor-logging", "1.1.1");
$rmod.def("/raptor-logging@1.1.1/lib/raptor-logging", function(require, exports, module, __filename, __dirname) { var process=require("process"); var EMPTY_FUNC = function() {
        return false;
    },
    /**
     * @name raptor/logging/voidLogger
     */
    voidLogger = {

        /**
         *
         */
        isTraceEnabled: EMPTY_FUNC,

        /**
         *
         */
        isDebugEnabled: EMPTY_FUNC,

        /**
         *
         */
        isInfoEnabled: EMPTY_FUNC,

        /**
         *
         */
        isWarnEnabled: EMPTY_FUNC,

        /**
         *
         */
        isErrorEnabled: EMPTY_FUNC,

        /**
         *
         */
        isFatalEnabled: EMPTY_FUNC,

        /**
         *
         */
        dump: EMPTY_FUNC,

        /**
         *
         */
        trace: EMPTY_FUNC,

        /**
         *
         */
        debug: EMPTY_FUNC,

        /**
         *
         */
        info: EMPTY_FUNC,

        /**
         *
         */
        warn: EMPTY_FUNC,

        /**
         *
         */
        error: EMPTY_FUNC,

        /**
         *
         */
        fatal: EMPTY_FUNC
    };

var stubs = {
    /**
     *
     * @param className
     * @returns
     */
    logger: function() {
        return voidLogger;
    },

    configure: EMPTY_FUNC,

    voidLogger: voidLogger
};


module.exports = stubs;

// Trick the JavaScript module bundler so that it doesn't include the implementation automatically
var RAPTOR_LOGGING_IMPL = './raptor-logging-impl';

if (!process.browser) {
    var implPath;

    try {
        implPath = require.resolve(RAPTOR_LOGGING_IMPL);
    } catch(e) {
        /*
        Fixes https://github.com/raptorjs/raptor-logging/issues/4
        If `./raptor-logging-impl` is unable to be loaded then it means that a server bundle was built and it does
        not support dynamic requires since the server bundle is being loaded from a different
        directory that breaks the relative path.
        */
    }
    if (implPath) {
        require(implPath);
    }
}
});
$rmod.def("/raptor-logging@1.1.1/lib/index", function(require, exports, module, __filename, __dirname) { var g = typeof window === 'undefined' ? global : window;
// Make this module a true singleton
module.exports = g.__RAPTOR_LOGGING || (g.__RAPTOR_LOGGING = require('./raptor-logging'));
});
$rmod.dep("", "raptor-async", "1.1.2");
$rmod.def("/raptor-async@1.1.2/AsyncValue", function(require, exports, module, __filename, __dirname) { var process=require("process"); // NOTE: Be careful if these numeric values are changed
//       because some of the logic is based on an assumed
//       sequencial order.
var STATE_INITIAL = 0;
var STATE_LOADING = 1;
var STATE_RESOLVED = 2;
var STATE_REJECTED = 3;

var now = Date.now || function() {
    return (new Date()).getTime();
};

function AsyncValue(options) {

    /**
     * The data that was provided via call to resolve(data).
     * This property is assumed to be public and available for inspection.
     */
    this.data = undefined;

    /**
     * The data that was provided via call to reject(err)
     * This property is assumed to be public and available for inspection.
     */
    this.error = undefined;

    /**
     * The queue of callbacks that are waiting for data
     */
    this._callbacks = undefined;

    /**
     * The state of the data holder (STATE_INITIAL, STATE_RESOLVED, or STATE_REJECTED)
     */
    this._state = STATE_INITIAL;

    /**
     * The point in time when this data provider was settled.
     */
    this._timestamp = undefined;

    if (options) {
        /**
         * An optional function that will be invoked to load the data
         * the first time data is requested.
         */
        this._loader = options.loader;

        /**
         * The "this" object that will be used when invoking callbacks and loaders.
         * NOTE: Some callbacks may have provided their own scope and that will be used
         *       instead of this scope.
         */
        this._scope = options.scope;

        /**
         * Time-to-live (in milliseconds).
         * A data holder can automatically invalidate it's held data or error after a preset period
         * of time. This should be used in combination of a loader. This is helpful in cases
         * where a data holder is used for caching purposes.
         */
        this._ttl = options.ttl || undefined;
    }
}

function notifyCallbacks(dataHolder, err, data) {
    var callbacks = dataHolder._callbacks;
    if (callbacks !== undefined) {
        // clear out the registered callbacks (we still have reference to the original value)
        dataHolder._callbacks = undefined;

        // invoke all of the callbacks and use their scope
        for (var i = 0; i < callbacks.length; i++) {
            // each callback is actually an object with "scope and "callback" properties
            var callbackInfo = callbacks[i];
            callbackInfo.callback.call(callbackInfo.scope, err, data);
        }
    }
}

function invokeLoader(dataProvider) {
    // transition to the loading state
    dataProvider._state = STATE_LOADING;

    // call the loader
    dataProvider._loader.call(dataProvider._scope || dataProvider, function (err, data) {
        if (err) {
            // reject with error
            dataProvider.reject(err);
        } else {
            // resolve with data
            dataProvider.resolve(data);
        }
    });
}

function addCallback(dataProvider, callback, scope) {
    if (dataProvider._callbacks === undefined) {
        dataProvider._callbacks = [];
    }

    dataProvider._callbacks.push({
        callback: callback,
        scope: scope || dataProvider._scope || dataProvider
    });
}

function isExpired(dataProvider) {
    var timeToLive = dataProvider._ttl;
    if ((timeToLive !== undefined) && ((now() - dataProvider._timestamp) > timeToLive)) {
        // unsettle the data holder if we find that it is expired
        dataProvider.unsettle();
        return true;
    } else {
        return false;
    }
}

AsyncValue.prototype = {

    /**
     * Has resolved function been called?
     */
    isResolved: function() {

        return (this._state === STATE_RESOLVED) && !isExpired(this);
    },

    /**
     * Has reject function been called?
     */
    isRejected: function() {
        return (this._state === STATE_REJECTED) && !isExpired(this);
    },

    /**
     * Is there an outstanding request to load data via loader?
     */
    isLoading: function() {
        return (this._state === STATE_LOADING);
    },

    /**
     * Has reject or resolve been called?
     *
     * This method will also do time-to-live checks if applicable.
     * If this data holder was settled prior to calling this method
     * but the time-to-live has been exceeded then the state will
     * returned to unsettled state and this method will return false.
     */
    isSettled: function() {
        // are we in STATE_RESOLVED or STATE_REJECTED?
        return (this._state > STATE_LOADING) && !isExpired(this);
    },

    /**
     * Trigger loading data if we have a loader and we are not already loading.
     * Even if a data holder is in a resolved or rejected state, load can be called
     * to get a new value.
     *
     * @return the resolved data (if loader synchronously calls resolve)
     */
    load: function(callback, scope) {
        if (!this._loader) {
            throw new Error('Cannot call load when loader is not configured');
        }

        if (this.isSettled()) {
            // clear out the old data and error
            this.unsettle();
        }

        // callback is optional for load call
        if (callback) {
            addCallback(this, callback, scope);
        }

        if (this._state !== STATE_LOADING) {
            // trigger the loading
            invokeLoader(this);
        }

        return this.data;
    },

    /**
     * Adds a callback to the queue. If there is not a pending request to load data
     * and we have a "loader" then we will use that loader to request the data.
     * The given callback will be invoked when there is an error or resolved data
     * available.
     */
    done: function (callback, scope) {
        if (!callback || (callback.constructor !== Function)) {
            throw new Error('Invalid callback: ' + callback);
        }

        // Do we already have data or error?
        if (this.isSettled()) {
            // invoke the callback immediately
            return callback.call(scope || this._scope || this, this.error, this.data);
        }

        if (process.domain) {
            callback = process.domain.bind(callback);
        }

        addCallback(this, callback, scope);

        // only invoke loader if we have loader and we are not currently loading value
        if (this._loader && (this._state !== STATE_LOADING)) {
            invokeLoader(this);
        }
    },

    /**
     * This method will trigger any callbacks to be notified of rejection (error).
     * If this data holder has a loader then the data holder will be returned to
     * its initial state so that any future requests to load data will trigger a
     * new load call.
     */
    reject: function(err) {
        // remember the error
        this.error = err;

        // clear out the data
        this.data = undefined;

        // record timestamp of when we were settled
        if (this._ttl !== undefined) {
            this._timestamp = now();
        }

        // Go to the rejected state if we don't have a loader.
        // If we do have a loader then return to the initial state
        // (we do this so that next call to done() will trigger load
        // again in case the error was transient).
        this._state = this._loader ? STATE_INITIAL : STATE_REJECTED;

        // always notify callbacks regardless of whether or not we return to the initial state
        notifyCallbacks(this, err, null);
    },

    /**
     * This method will trigger any callbacks to be notified of data.
     */
    resolve: function (data) {
        // clear out the error
        this.error = undefined;

        // remember the state
        this.data = data;

        // record timestamp of when we were settled
        if (this._ttl !== undefined) {
            this._timestamp = now();
        }

        // go to the resolved state
        this._state = STATE_RESOLVED;

        // notify callbacks
        notifyCallbacks(this, null, data);
    },

    /**
     * Clear out data or error and return this data holder to initial state.
     * If the are any pending callbacks then those will be removed and not invoked.
     */
    reset: function () {
        // return to the initial state and clear error and data
        this.unsettle();

        // remove any callbacks
        this.callbacks = undefined;
    },

    /**
     * Return to the initial state and clear stored error or data.
     * If there are any callbacks still waiting for data, then those
     * will be retained.
     */
    unsettle: function () {
        // return to initial state
        this._state = STATE_INITIAL;

        // reset error value
        this.error = undefined;

        // reset data value
        this.data = undefined;

        // clear the timestamp of when we were settled
        this._timestamp = undefined;
    }
};

AsyncValue.create = function(config) {
    return new AsyncValue(config);
};

module.exports = AsyncValue;

});
$rmod.remap("/marko@3.3.0/taglibs/async/client-reorder", "client-reorder-browser");
$rmod.def("/marko@3.3.0/taglibs/async/client-reorder-browser", function(require, exports, module, __filename, __dirname) { exports.isSupported = false;
});
$rmod.def("/marko@3.3.0/taglibs/async/async-fragment-tag", function(require, exports, module, __filename, __dirname) { 'use strict';

var logger = require('/$/raptor-logging'/*'raptor-logging'*/).logger(module);
var asyncWriter = require('/$/async-writer'/*'async-writer'*/);
var AsyncValue = require('/$/raptor-async/AsyncValue'/*'raptor-async/AsyncValue'*/);
var isClientReorderSupported = require('./client-reorder').isSupported;

function isPromise(o) {
    return o && typeof o.then === 'function';
}

function promiseToCallback(promise, callback, thisObj) {
    if (callback) {
      var finalPromise = promise
        .then(function(data) {
          callback(null, data);
        });

      if (typeof promise.catch === 'function') {
        finalPromise = finalPromise.catch(function(err) {
          callback(err);
        });
      } else if (typeof promise.fail === 'function') {
        finalPromise = finalPromise.fail(function(err) {
          callback(err);
        });
      }

      if (finalPromise.done) {
        finalPromise.done();
      }
    }

    return promise;
}

function requestData(provider, args, callback, thisObj) {

    if (isPromise(provider)) {
        // promises don't support a scope so we can ignore thisObj
        promiseToCallback(provider, callback);
        return;
    }

    if (typeof provider === 'function') {
        var data = (provider.length === 1) ?
        // one argument so only provide callback to function call
        provider.call(thisObj, callback) :

        // two arguments so provide args and callback to function call
        provider.call(thisObj, args, callback);

        if (data !== undefined) {
            if (isPromise(data)) {
                promiseToCallback(data, callback);
            }
            else {
                callback(null, data);
            }
        }
    } else {
        // Assume the provider is a data object...
        callback(null, provider);
    }
}

module.exports = function render(input, out) {
    var dataProvider = input.dataProvider;
    var arg = input.arg || {};
    arg.out = out;
    var events = out.global.events;

    var clientReorder = isClientReorderSupported && input.clientReorder === true;
    var asyncOut;
    var done = false;
    var timeoutId = null;
    var name = input.name || input._name;
    var scope = input.scope || this;

    function renderBody(err, data, renderTimeout) {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }

        done = true;

        var targetOut = asyncOut || out;

        events.emit('asyncFragmentBeforeRender', {
            clientReorder: clientReorder,
            out: targetOut,
            name: name
        });

        if (err) {
            if (input.renderError) {
                console.error('Async fragment (' + name + ') failed. Error:', (err.stack || err));
                input.renderError(targetOut);
            } else {
                targetOut.error(err);
            }
        } else if (renderTimeout) {
            renderTimeout(asyncOut);
        } else {
            if (input.renderBody) {
                input.renderBody(targetOut, data);
            }
        }

        if (!clientReorder) {
            events.emit('asyncFragmentFinish', {
                clientReorder: false,
                out: targetOut,
                name: name 
            });
        }

        if (asyncOut) {
            asyncOut.end();

            // Only flush if we rendered asynchronously and we aren't using
            // client-reordering
            if (!clientReorder) {
                out.flush();
            }
        }
    }

    var method = input.method;
    if (method) {
        dataProvider = dataProvider[method].bind(dataProvider);
    }

    requestData(dataProvider, arg, renderBody, scope);

    if (!done) {
        var timeout = input.timeout;
        var renderTimeout = input.renderTimeout;
        var renderPlaceholder = input.renderPlaceholder;

        if (timeout == null) {
            timeout = 10000;
        } else if (timeout <= 0) {
            timeout = null;
        }

        if (timeout != null) {
            timeoutId = setTimeout(function() {
                var message = 'Async fragment (' + name + ') timed out after ' + timeout + 'ms';

                if (renderTimeout) {
                    logger.error(message);
                    renderBody(null, null, renderTimeout);
                } else {
                    renderBody(new Error(message));
                }
            }, timeout);
        }

        if (clientReorder) {
            var asyncFragmentContext = out.global.__asyncFragments || (asyncFragmentContext = out.global.__asyncFragments = {
                fragments: [],
                nextId: 0
            });

            var id = input.name || asyncFragmentContext.nextId++;

            if (renderPlaceholder) {
                out.write('<span id="afph' + id + '">');
                renderPlaceholder(out);
                out.write('</span>');
            } else {
                out.write('<noscript id="afph' + id + '"></noscript>');
            }

            var asyncValue = new AsyncValue();

            // Write to an in-memory buffer
            asyncOut = asyncWriter.create(null, {global: out.global});

            asyncOut
                .on('finish', function() {
                    asyncValue.resolve(asyncOut.getOutput());
                })
                .on('error', function(err) {
                    asyncValue.reject(err);
                });

            var fragmentInfo = {
                id: id,
                asyncValue: asyncValue,
                out: asyncOut,
                after: input.showAfter
            };

            if (asyncFragmentContext.fragments) {
                asyncFragmentContext.fragments.push(fragmentInfo);
            } else {
                events.emit('asyncFragmentBegin', fragmentInfo);
            }

        } else {
            out.flush(); // Flush everything up to this async fragment
            asyncOut = out.beginAsync({
                timeout: 0, // We will use our code for controlling timeout
                name: name
            });
        }
    }
};

});
$rmod.def("/marko@3.3.0/taglibs/async/async-fragments-tag", function(require, exports, module, __filename, __dirname) { var clientReorder = require('./client-reorder');

module.exports = function(input, out) {
    var global = out.global;
    var events = global.events;

    out.flush();

    var asyncOut = out.beginAsync({ last: true, timeout: -1 });
    out.onLast(function(next) {
        var asyncFragmentsContext = global.__asyncFragments;

        if (!asyncFragmentsContext || !asyncFragmentsContext.fragments.length) {
            asyncOut.end();
            next();
            return;
        }

        var remaining = asyncFragmentsContext.fragments.length;

        var done = false;

        function handleAsyncFragment(af) {
            af.asyncValue.done(function(err, html) {
                if (done) {
                    return;
                }

                if (err) {
                    done = true;
                    return asyncOut.error(err);
                }

                if (!global._afRuntime) {
                    asyncOut.write(clientReorder.getCode());
                    global._afRuntime = true;
                }

                asyncOut.write('<div id="af' + af.id + '" style="display:none">' +
                    html +
                    '</div>' +
                    '<script type="text/javascript">$af(' + (typeof af.id === 'number' ? af.id : '"' + af.id + '"') + (af.after ? (',"' + af.after + '"') : '' ) + ')</script>');

                af.out.writer = asyncOut.writer;

                events.emit('asyncFragmentFinish', {
                    clientReorder: true,
                    out: af.out,
                    name: af.id
                });

                out.flush();

                if (--remaining === 0) {
                    done = true;
                    asyncOut.end();
                    next();
                }
            });
        }

        asyncFragmentsContext.fragments.forEach(handleAsyncFragment);

        events.on('asyncFragmentBegin', function(af) {
            remaining++;
            handleAsyncFragment(af);
        });

        // Now that we have a listener attached, we want to receive any additional
        // out-of-sync fragments via an event
        delete asyncFragmentsContext.fragments;
    });
};
});
$rmod.def("/marko@3.3.0/taglibs/async/client-reorder-runtime", function(require, exports, module, __filename, __dirname) { function $af(id, after, doc, sourceEl, targetEl, docFragment, childNodes, i, len, af) {
    af = $af;

    if (after && !af[after]) {
        (af[(after = after + '$')] || (af[after] = [])).push(id);
    } else {
        doc = document;
        sourceEl = doc.getElementById('af' + id);
        targetEl = doc.getElementById('afph' + id);
        docFragment = doc.createDocumentFragment();
        childNodes = sourceEl.childNodes;
        i = 0;
        len=childNodes.length;

        for (; i<len; i++) {
            docFragment.appendChild(childNodes.item(0));
        }

        targetEl.parentNode.replaceChild(docFragment, targetEl);
        af[id] = 1;

        after = af[id + '$'];

        if (after) {
            i = 0;
            len = after.length;

            for (; i<len; i++) {
                af(after[i]);
            }
        }
    }

    // sourceEl.parentNode.removeChild(sourceEl);
}
});
$rmod.def("/marko@3.3.0/taglibs/async/client-reorder-runtime.min", function(require, exports, module, __filename, __dirname) { function $af(d,a,e,l,g,h,k,b,f,c){c=$af;if(a&&!c[a])(c[a+="$"]||(c[a]=[])).push(d);else{e=document;l=e.getElementById("af"+d);g=e.getElementById("afph"+d);h=e.createDocumentFragment();k=l.childNodes;b=0;for(f=k.length;b<f;b++)h.appendChild(k.item(0));g.parentNode.replaceChild(h,g);c[d]=1;if(a=c[d+"$"])for(b=0,f=a.length;b<f;b++)c(a[b])}};
});
$rmod.def("/marko@3.3.0/taglibs/core/assign-tag", function(require, exports, module, __filename, __dirname) { module.exports = function codeGenerator(elNode, generator) {
    var attributes = elNode.attributes;

    if (!attributes) {
        generator.addError('Invalid <assign> tag. Argument is missing. Example; <assign x=123 />');
        return elNode;
    }

    var builder = generator.builder;

    return attributes.map((attr) => {
        return builder.assignment(attr.name, attr.value);
    });
};
});
$rmod.def("/marko@3.3.0/compiler/util/removeComments", function(require, exports, module, __filename, __dirname) { 'use strict';
var tokenizer = require('./tokenizer').create([
    {
        name: 'stringDouble',
        pattern: /"(?:[^"]|\\")*"/,
    },
    {
        name: 'stringSingle',
        pattern: /'(?:[^']|\\')*'/
    },
    {
        name: 'singleLineComment',
        pattern: /\/\/.*/
    },
    {
        name: 'multiLineComment',
        pattern: /\/\*(?:[\s\S]*?)\*\//
    }
]);

/**
 * Parses a for loop string in the following forms:
 *
 * <varName> in <expression>
 * <varName> in <expression> | status-var=<varName> separator=<expression>
 * <varName> from <expression> to <expression>
 * <varName> from <expression> to <expression> step <expression>
 * <init>; <test>; <update>
 */
module.exports = function removeComments(str) {

    var comments = [];

    tokenizer.forEachToken(str, (token) => {
        switch(token.name) {
            case 'singleLineComment':
            case 'multiLineComment':
                comments.push(token);
                break;
        }
    });

    var len = comments.length;

    if (len) {
        for (var i=len-1; i>=0; i--) {
            var comment = comments[i];
            str = str.substring(0, comment.start) + str.substring(comment.end);
        }
    }

    return str;
};
});
$rmod.def("/marko@3.3.0/compiler/util/tokenizer", function(require, exports, module, __filename, __dirname) { 'use strict';

function create(tokens) {
    function getToken(matches) {
        for (var i=0; i<tokens.length; i++) {
            let tokenValue = matches[i + 1];
            if (tokenValue != null) {
                var tokenDef = tokens[i];
                return {
                    start: matches.index,
                    end: matches.index + matches[0].length,
                    name: tokenDef.name,
                    value: tokenValue
                };
            }
        }
    }

    var tokensRegExp = new RegExp(tokens
        .map((token) => {
            return '(' + token.pattern.source + ')';
        })
        .join('|'), 'g');

    return {
        forEachToken: function(value, callback, thisObj) {
            tokensRegExp.lastIndex = 0; // Start searching from the beginning again
            var matches;
            while ((matches = tokensRegExp.exec(value))) {
                let token = getToken(matches);
                callback.call(this, token);
            }
        }
    };
}

exports.create = create;
});
$rmod.def("/marko@3.3.0/taglibs/core/util/parseFor", function(require, exports, module, __filename, __dirname) { 'use strict';
var removeComments = require('../../../compiler/util/removeComments');
var compiler = require('../../../compiler');

var integerRegExp = /^-?\d+$/;
var numberRegExp = /^-?(?:\d+|\d+\.\d*|\d*\.\d+|\d+\.\d+)$/;

var tokenizer = require('../../../compiler/util/tokenizer').create([
    {
        name: 'stringDouble',
        pattern: /"(?:[^"]|\\")*"/,
    },
    {
        name: 'stringSingle',
        pattern: /'(?:[^']|\\')*'/
    },
    {
        name: 'in',
        pattern: /\s+in\s+/,
    },
    {
        name: 'from',
        pattern: /\s+from\s+/
    },
    {
        name: 'to',
        pattern: /\s+to\s+/,
    },
    {
        name: 'step',
        pattern: /\s+step\s+/,
    },
    {
        name: 'semicolon',
        pattern: /[;]/,
    },
    {
        name: 'separator',
        pattern: /separator=/
    },
    {
        name: 'status-var',
        pattern: /status\-var=/
    },
    {
        name: 'iterator',
        pattern: /iterator=/
    },
    {
        name: 'pipe',
        pattern: /\s+\|\s+/
    },
    {
        name: 'groupOpen',
        pattern: /[\{\(\[]/
    },
    {
        name: 'groupClose',
        pattern: /[\}\)\]]/
    }
]);

function throwError(message) {
    var error = new Error(message);
    error.code = 'INVALID_FOR';
    throw error;
}

function buildIdentifier(name, errorMessage) {
    try {
        return compiler.builder.identifier(name);
    } catch(e) {
        throwError(errorMessage + ': ' + e.message);
    }
}

function parseExpression(str, errorMessage) {
    try {
        return compiler.builder.parseExpression(str);
    } catch(e) {
        throwError(errorMessage + ': ' + e.message);
    }
}

function parseStatement(str, errorMessage) {
    try {
        return compiler.builder.parseStatement(str);
    } catch(e) {
        throwError(errorMessage + ': ' + e.message);
    }
}

function createNumberExpression(str, errorMessage) {
    if (str == null) {
        return null;
    }

    if (integerRegExp.test(str)) {
        return compiler.builder.literal(parseInt(str, 10));
    } else if (numberRegExp.test(str)) {
        return compiler.builder.literal(parseFloat(str));
    } else {
        return parseExpression(str, errorMessage);
    }
}

/**
 * Parses a for loop string in the following forms:
 *
 * <varName> in <expression>
 * <varName> in <expression> | status-var=<varName> separator=<expression>
 * <varName> from <expression> to <expression>
 * <varName> from <expression> to <expression> step <expression>
 * <init>; <test>; <update>
 */
module.exports = function(str) {
    str = removeComments(str);

    let depth = 0;
    var prevToken;
    var loopType;
    var pipeFound = false;

    var varName;
    var nameVarName;
    var valueVarName;
    var inExpression;
    var statusVarName;
    var separatorExpression;
    var fromExpression;
    var toExpression;
    var stepExpression;
    var iteratorExpression;

    var forInit;
    var forTest;
    var forUpdate;

    function finishVarName(end) {
        varName = str.substring(0, end).trim();
    }

    function finishPrevPart(end) {
        if (!prevToken) {
            return;
        }

        var start = prevToken.end;
        var part = str.substring(start, end).trim();

        switch(prevToken.name) {
            case 'from':
                fromExpression = part;
                break;
            case 'to':
                toExpression = part;
                break;
            case 'in':
                inExpression = part;
                break;
            case 'step':
                stepExpression = part;
                break;
            case 'status-var':
                statusVarName = part;
                break;
            case 'separator':
                separatorExpression = part;
                break;
            case 'iterator':
                iteratorExpression = part;
                break;
            case 'pipe':
                if (part.length !== 0) {
                    throwError('Unexpected input: ' + part);
                    return;
                }
                break;
        }
    }

    tokenizer.forEachToken(str, (token) => {
        switch(token.name) {
            case 'groupOpen':
                depth++;
                break;
            case 'groupClose':
                depth--;
                break;
            case 'in':
                if (depth === 0 && !loopType) {
                    loopType = 'ForEach';
                    finishVarName(token.start);
                    prevToken = token;
                }
                break;
            case 'from':
                if (depth === 0 && !loopType) {
                    loopType = 'ForRange';
                    finishVarName(token.start);
                    prevToken = token;
                }
                break;
            case 'to':
                if (depth === 0 && prevToken && prevToken.name === 'from') {
                    finishPrevPart(token.start);
                    prevToken = token;
                }
                break;
            case 'step':
                if (depth === 0 && prevToken && prevToken.name === 'to') {
                    finishPrevPart(token.start);
                    prevToken = token;
                }
                break;
            case 'semicolon':
                if (depth === 0) {
                    loopType = 'For';

                    if (forInit == null) {
                        forInit = str.substring(0, token.start);
                    } else if (forTest == null) {
                        forTest = str.substring(prevToken.end, token.start);
                        forUpdate = str.substring(token.end);
                    } else {
                        throwError('Invalid native for loop. Expected format: <init>; <test>; <update>');
                    }

                    prevToken = token;
                }
                break;
            case 'pipe':
                if (depth === 0) {
                    pipeFound = true;
                    finishPrevPart(token.start);
                    prevToken = token;
                }
                break;
            case 'status-var':
                if (depth === 0 && pipeFound && str.charAt(token.start-1) === ' ') {
                    finishPrevPart(token.start);
                    prevToken = token;
                }
                break;
            case 'separator':
                if (depth === 0 && pipeFound && str.charAt(token.start-1) === ' ') {
                    finishPrevPart(token.start);
                    prevToken = token;
                }
                break;
            case 'iterator':
                if (depth === 0 && pipeFound && str.charAt(token.start-1) === ' ') {
                    finishPrevPart(token.start);
                    prevToken = token;
                }
                break;
        }
    });

    finishPrevPart(str.length);

    if (loopType === 'ForEach') {
        var nameValue = varName.split(/\s*,\s*/);
        if (nameValue.length === 2) {
            nameVarName = buildIdentifier(nameValue[0], 'Invalid name variable');
            valueVarName = buildIdentifier(nameValue[1], 'Invalid value variable');
            varName = null;
            loopType = 'ForEachProp';
        }
    }

    if (inExpression) {
        inExpression = parseExpression(inExpression, 'Invalid "in" expression');
    }

    if (separatorExpression) {
        separatorExpression = parseExpression(separatorExpression, 'Invalid "separator" expression');
    }

    if (iteratorExpression) {
        iteratorExpression = parseExpression(iteratorExpression, 'Invalid "iterator" expression');
    }

    if (fromExpression) {
        fromExpression = createNumberExpression(fromExpression, 'Invalid "from" expression');
    }

    if (toExpression) {
        toExpression = createNumberExpression(toExpression, 'Invalid "to" expression');
    }

    if (stepExpression) {
        stepExpression = createNumberExpression(stepExpression, 'Invalid "step" expression');
    }

    if (varName != null) {
        varName = buildIdentifier(varName, 'Invalid variable name');
    }

    if (statusVarName) {
        statusVarName = parseExpression(statusVarName, 'Invalid status-var option');
        if (statusVarName.type === 'Literal') {
            statusVarName = compiler.builder.identifier(statusVarName.value);
        } else  if (statusVarName.type !== 'Identifier') {
            throwError('Invalid status-var option');
        }
    }

    if (forInit) {
        forInit = parseStatement(forInit, 'Invalid for loop init');
    }

    if (forTest) {
        forTest = parseExpression(forTest, 'Invalid for loop test');
    }

    if (forUpdate) {
        forUpdate = parseExpression(forUpdate, 'Invalid for loop update');
    }

    // No more tokens... now we need to sort out what happened
    if (loopType === 'ForEach') {
        return {
            'loopType': loopType,
            'varName': varName,
            'in': inExpression,
            'separator': separatorExpression,
            'statusVarName': statusVarName,
            'iterator': iteratorExpression
        };
    } else if (loopType === 'ForEachProp') {
        return {
            'loopType': loopType,
            'nameVarName': nameVarName,
            'valueVarName': valueVarName,
            'in': inExpression
        };
    } else if (loopType === 'ForRange') {
        return {
            'loopType': loopType,
            'varName': varName,
            'from': fromExpression,
            'to': toExpression,
            'step': stepExpression
        };
    } else if (loopType === 'For') {
        if (forTest == null) {
            throwError('Invalid native for loop. Expected format: <init>; <test>; <update>');
        }
        return {
            'loopType': loopType,
            'init': forInit,
            'test': forTest,
            'update': forUpdate
        };
    } else {
        throwError('Invalid for loop');
    }
};
});
$rmod.def("/marko@3.3.0/taglibs/core/util/createLoopNode", function(require, exports, module, __filename, __dirname) { var parseFor = require('./parseFor');

function createLoopNode(str, body, builder) {
    var forDef = parseFor(str);

    forDef.body = body;

    if (forDef.loopType === 'ForEach') {
        return builder.forEach(forDef);
    } else if (forDef.loopType === 'ForRange') {
        return builder.forRange(forDef);
    } else if (forDef.loopType === 'ForEachProp') {
        return builder.forEachProp(forDef);
    } else if (forDef.loopType === 'For') {
        return builder.forStatement(forDef);
    } else {
        throw new Error('Unsupported loop type: ' + forDef.loopType);
    }
}

module.exports = createLoopNode;

});
$rmod.def("/marko@3.3.0/taglibs/core/core-transformer", function(require, exports, module, __filename, __dirname) { 'use strict';

var createLoopNode = require('./util/createLoopNode');

var coreAttrHandlers = [
    [
        'while', function(attr, node) {
            var whileArgument = attr.argument;
            if (!whileArgument) {
                return false;
            }

            var whileNode = this.builder.whileStatement(whileArgument);
            node.wrapWith(whileNode);
        }
    ],
    [
        'for', function(attr, node) {
            var forArgument = attr.argument;
            if (!forArgument) {
                return false;
            }

            var loopNode;

            try {
                loopNode = createLoopNode(forArgument, null, this.builder);
            } catch(e) {
                if (e.code === 'INVALID_FOR') {
                    this.addError(e.message);
                    return;
                } else {
                    throw e;
                }
            }


            //Surround the existing node with the newly created loop node
            // NOTE: The loop node will be one of the following:
            //       ForEach, ForRange, ForEachProp or ForStatement
            node.wrapWith(loopNode);
        }
    ],
    [
        'if', function(attr, node) {
            var ifArgument = attr.argument;
            if (!ifArgument) {
                return false;
            }

            var test;
            try {
                test = this.builder.parseExpression(ifArgument);
            } catch(e) {
                test = this.builder.literalFalse();
                this.addError('Invalid expression for if statement:\n' + e.message);
            }

            var ifNode = this.builder.ifStatement(test);
            //Surround the existing node with an "If" node
            node.wrapWith(ifNode);
        }
    ],
    [
        'unless', function(attr, node) {
            var ifArgument = attr.argument;
            if (!ifArgument) {
                return false;
            }

            var test;
            try {
                test = this.builder.parseExpression(ifArgument);
            } catch(e) {
                test = this.builder.literalFalse();
                this.addError('Invalid expression for unless statement:\n' + e.message);
            }

            test = this.builder.negate(test);
            var ifNode = this.builder.ifStatement(test);
            //Surround the existing node with an "if" node
            node.wrapWith(ifNode);
        }
    ],
    [
        'else-if', function(attr, node) {
            var elseIfArgument = attr.argument;
            if (!elseIfArgument) {
                return false;
            }

            var test;
            try {
                test = this.builder.parseExpression(elseIfArgument);
            } catch(e) {
                test = this.builder.literalFalse();
                this.addError('Invalid expression for else-if statement:\n' + e.message);
            }

            var elseIfNode = this.builder.elseIfStatement(test);
            //Surround the existing node with an "ElseIf" node
            node.wrapWith(elseIfNode);
        }
    ],
    [
        'else', function(attr, node) {
            var elseNode = this.builder.elseStatement();
            //Surround the existing node with an "Else" node
            node.wrapWith(elseNode);
        }
    ],
    [
        'body-only-if', function(attr, node, el) {
            var argument = attr.argument;
            if (!argument) {
                return false;
            }

            var test;
            try {
                test = this.builder.parseExpression(argument);
            } catch(e) {
                test = this.builder.literalFalse();
                this.addError('Invalid expression for body-only-if statement:\n' + e.message);
            }

            el.setBodyOnlyIf(test);
        }
    ],
    [
        'marko-preserve-whitespace', function(attr, node, el) {
            el.setPreserveWhitespace(true);
        }
    ],
    [
        'marko-init', function(attr, node, el) {
            if (el.tagName !== 'script') {
                this.addError('The "marko-init" attribute should only be used on the <script> tag');
                return;
            }
            var bodyText = el.bodyText;
            el.noOutput = true;
            this.context.addStaticCode(bodyText);
            el.detach();
            return null;
        }
    ]
];

class AttributeTransformer {
    constructor(context, el) {
        this.context = context;
        this.builder = context.builder;
        this.el = el;
    }

    addError(message) {
        this.context.addError({
            node: this.el,
            message: message
        });
    }
}

coreAttrHandlers.forEach(function(attrHandler) {
    var name = attrHandler[0];
    var func = attrHandler[1];
    AttributeTransformer.prototype[name] = func;
});

var attributeTransformers = AttributeTransformer.prototype;

module.exports = function transform(el, context) {
    el.removeAttribute('marko-body'); // This attribute is handled at parse time. We can just remove it now

    var attributeTransfomer;
    var node = el;

    el.forEachAttribute((attr) => {
        let attrName = attr.name;
        if (!attrName) {
            if (!node.addDynamicAttributes) {
                context.addError(el, 'Node does not support the "attrs" attribute');
            } else {
                node.addDynamicAttributes(attr.value);
            }
            return;
        }
        var attrTransformerFunc = attributeTransformers[attrName];
        if (attrTransformerFunc) {
            if (!attributeTransfomer) {
                attributeTransfomer = new AttributeTransformer(context, el);
            }
            var newNode = attributeTransfomer[attrName](attr, node, el);
            if (newNode !== false) {
                el.removeAttribute(attrName);
                if (newNode !== undefined) {
                    if (newNode) {
                        newNode.pos = node.pos;
                    }

                    node = newNode;
                }
            }
        }
    });
};
});
$rmod.def("/marko@3.3.0/taglibs/core/else-if-tag", function(require, exports, module, __filename, __dirname) { module.exports = function nodeFactory(el, context) {
    var argument = el.argument;
    var attributes = el.attributes;


    if (!argument) {
        context.addError(el, 'Invalid <else-if> tag. Argument is missing. Example; <if(foo === true)>');
        return el;
    }

    if (attributes.length) {
        context.addError(el, 'Invalid <else-if> tag. Attributes not allowed.');
        return el;
    }

    var test;
    try {
        test = context.builder.parseExpression(argument);
    } catch(e) {
        test = context.builder.literalFalse();
        context.addError(el, 'Invalid expression for else-if statement:\n' + e.message);
    }

    var elseIfStatement = context.builder.elseIfStatement(test);
    return elseIfStatement;
};
});
$rmod.def("/marko@3.3.0/taglibs/core/else-tag", function(require, exports, module, __filename, __dirname) { 'use strict';

module.exports = function nodeFactory(el, context) {

    var elseStatement = context.builder.elseStatement();

    var argument = el.argument;
    if (argument) {
        context.addError(elseStatement, 'Invalid <else> tag. Argument is not allowed');
    }

    if (el.hasAttribute('if')) {
        let ifAttr = el.getAttribute('if');
        el.removeAttribute('if');

        if (el.attributes.length) {
            context.addError(elseStatement, 'Invalid <else if> tag. Only the "if" attribute is allowed.');
            return el;
        }

        var testExpression = ifAttr.argument;
        if (!testExpression) {
            context.addError(elseStatement, 'Invalid <else if> tag. Invalid "if" attribute. Expected: <else if(<test>)>');
            return el;
        }
        var elseIfStatement = context.builder.elseIfStatement(testExpression);
        return elseIfStatement;
    }

    if (el.attributes.length) {
        context.addError(elseStatement, 'Invalid <else> tag. Attributes not allowed.');
        return el;
    }

    return elseStatement;
};
});
$rmod.def("/marko@3.3.0/taglibs/core/for-tag", function(require, exports, module, __filename, __dirname) { var createLoopNode = require('./util/createLoopNode');

module.exports = function codeGenerator(elNode, codegen) {
    var argument = elNode.argument;
    if (!argument) {
        codegen.addError('Invalid <for> tag. Argument is missing. Example: <for(color in colors)>');
        return elNode;
    }

    var builder = codegen.builder;

    try {
        var loopNode = createLoopNode(argument, elNode.body, builder);
        return loopNode;
    } catch(e) {
        if (e.code === 'INVALID_FOR') {
            codegen.addError(e.message);
        } else {
            throw e;
        }
    }

};
});
$rmod.def("/marko@3.3.0/taglibs/core/if-tag", function(require, exports, module, __filename, __dirname) { module.exports = function nodeFactory(elNode, context) {
    var argument = elNode.argument;

    if (!argument) {
        context.addError(elNode, 'Invalid <if> tag. Argument is missing. Example; <if(foo === true)>');
        return elNode;
    }

    var attributes = elNode.attributes;

    if (attributes.length) {
        context.addError(elNode, 'Invalid <if> tag. Attributes not allowed.');
        return;
    }

    var test;

    try {
        test = context.builder.parseExpression(argument);
    } catch(e) {
        test = context.builder.literalFalse();
        context.addError(elNode, 'Invalid expression for if statement:\n' + e.message);
    }

    return context.builder.ifStatement(test);
};
});
$rmod.def("/marko@3.3.0/taglibs/core/include-tag", function(require, exports, module, __filename, __dirname) { 'use strict';

module.exports = function codeGenerator(el, codegen) {
    let argument = el.argument;
    if (!argument) {
        return;
    }

    let builder = codegen.builder;
    let args = builder.parseJavaScriptArgs(argument);
    if (args.length === 0) {
        codegen.addError('Template path is required for the <include(templatePath[, templateData])> tag');
        return;
    } else if (args.length > 2) {
        codegen.addError('Wrong number of arguments passed to the <include> tag. Expected: <include(templatePath[, templateData])> tag');
        return;
    }

    let templatePath = args[0];
    let templateVar;

    if (templatePath.type === 'Literal') {
        templateVar = codegen.context.importTemplate(templatePath.value);
    } else {
        templateVar = templatePath;
    }

    let templateData = {};
    let attrs = el.getAttributes();
    attrs.forEach((attr) => {
        templateData[attr.name] = attr.value;
    });

    if (el.body && el.body.length) {
        templateData.renderBody = builder.renderBodyFunction(el.body);
    }

    if (args.length === 2) {
        if (Object.keys(templateData).length === 0) {
            templateData = args[1];
        } else {
            let mergeVar = codegen.addStaticVar('__merge', '__helpers.m');
            templateData = builder.functionCall(mergeVar, [
                builder.literal(templateData), // Input props from the attributes take precedence
                args[1] // The template data object is passed as the second argument: <include("./foo.marko", { ... })/>
            ]);
        }
    } else {
        templateData = builder.literal(templateData);
    }

    let renderMethod = builder.memberExpression(templateVar, builder.identifier('render'));
    let renderArgs = [ templateData, 'out' ];
    let renderFunctionCall = builder.functionCall(renderMethod, renderArgs);
    return renderFunctionCall;
};
});
$rmod.def("/marko@3.3.0/taglibs/core/include-text-tag-browser", function(require, exports, module, __filename, __dirname) { 'use strict';
module.exports = function codeGenerator(el, codegen) {
    let argument = el.argument;
    if (!argument) {
        return;
    }

    let builder = codegen.builder;
    let pathExpression = builder.parseExpression(argument);
    if (pathExpression.type !== 'Literal' || typeof pathExpression.value !== 'string') {
        codegen.addError('Argument to the <include-text> tag should be a string value: <include-text("./foo.txt")/>');
        return;
    }

    var path = pathExpression.value;
    return builder.text(builder.literal('<include-text> cannot be compiled in the browser (path="' + path + '")'));
};
});
$rmod.def("/marko@3.3.0/taglibs/core/invoke-tag", function(require, exports, module, __filename, __dirname) { module.exports = function codeGenerator(elNode, codegen) {
    var functionAttr = elNode.attributes[0];
    if (!functionAttr) {
        codegen.addError('Invalid <invoke> tag. Missing function attribute. Expected: <invoke console.log("Hello World")');
        return;
    }

    var arg = functionAttr.argument;

    if (arg === undefined) {
        codegen.addError('Invalid <invoke> tag. Missing function arguments. Expected: <invoke console.log("Hello World")');
        return;
    }

    var functionName = functionAttr.name;
    var functionCallExpression = functionName + '(' + arg + ')';
    return codegen.builder.parseExpression(functionCallExpression);
};
});
$rmod.def("/marko@3.3.0/taglibs/core/macro-body-tag", function(require, exports, module, __filename, __dirname) { module.exports = function codeGenerator(elNode, codegen) {
    var builder = codegen.builder;
    
    return builder.ifStatement(builder.identifier('renderBody'), [
        builder.functionCall('renderBody', ['out'])
    ]);
};
});
$rmod.def("/marko@3.3.0/taglibs/core/macro-tag", function(require, exports, module, __filename, __dirname) { module.exports = function codeGenerator(elNode, codegen) {

    var attributes = elNode.attributes;
    if (!attributes.length) {
        return;
    }

    var defAttr = attributes[0];
    if (defAttr.argument == null) {
        return;
    }

    var body = elNode.body;
    var macroName = defAttr.name;
    var argument = defAttr.argument;
    var params;
    if (argument) {
        params = argument.split(/\s*,\s*/);
    } else {
        params = [];
    }

    var builder = codegen.builder;

    return builder.macro(macroName, params, body);
};
});
$rmod.def("/marko@3.3.0/taglibs/core/marko-preserve-whitespace-tag", function(require, exports, module, __filename, __dirname) { module.exports = function codeGenerator(elNode, codegen) {
    return elNode.body;
};
});
$rmod.def("/marko@3.3.0/taglibs/core/unless-tag", function(require, exports, module, __filename, __dirname) { module.exports = function nodeFactory(elNode, context) {
    var argument = elNode.argument;

    if (!argument) {
        context.addError(elNode, 'Invalid <unless> tag. Argument is missing. Example; <unless(foo === true)>');
        return elNode;
    }

    var attributes = elNode.attributes;

    if (attributes.length) {
        context.addError(elNode, 'Invalid <unless> tag. Attributes not allowed.');
        return;
    }

    var builder = context.builder;

    var test;
    try {
        test = builder.parseExpression(argument);
    } catch(e) {
        test = builder.literalFalse();
        context.addError(elNode, 'Invalid expression for unless statement:\n' + e.message);
    }

    return context.builder.ifStatement(builder.negate(test));
};
});
$rmod.def("/marko@3.3.0/compiler/util/javaScriptReservedWords", function(require, exports, module, __filename, __dirname) { module.exports = {
    'abstract': true,
    'arguments': true,
    'boolean': true,
    'break': true,
    'byte': true,
    'case': true,
    'catch': true,
    'char': true,
    'class': true,
    'const': true,
    'continue': true,
    'debugger': true,
    'default': true,
    'delete': true,
    'do': true,
    'double': true,
    'else': true,
    'enum*': true,
    'eval': true,
    'export': true,
    'extends': true,
    'false': true,
    'final': true,
    'finally': true,
    'float': true,
    'for': true,
    'function': true,
    'goto': true,
    'if': true,
    'implements': true,
    'import': true,
    'in': true,
    'instanceof': true,
    'int': true,
    'interface': true,
    'let': true,
    'long': true,
    'native': true,
    'new': true,
    'null': true,
    'package': true,
    'private': true,
    'protected': true,
    'public': true,
    'return': true,
    'short': true,
    'static': true,
    'super': true,
    'switch': true,
    'synchronized': true,
    'this': true,
    'throw': true,
    'throws': true,
    'transient': true,
    'true': true,
    'try': true,
    'typeof': true,
    'var': true,
    'void': true,
    'volatile': true,
    'while': true,
    'with': true,
    'yield': true
};
});
$rmod.def("/marko@3.3.0/compiler/util/isValidJavaScriptVarName", function(require, exports, module, __filename, __dirname) { var reservedWords = require('./javaScriptReservedWords');
var varNameRegExp = /^[$A-Z_][0-9A-Z_$]*$/i;

module.exports = function isValidJavaScriptVarName(varName) {
    if (reservedWords[varName]) {
        return false;
    }

    return varNameRegExp.test(varName);
};

});
$rmod.def("/marko@3.3.0/taglibs/core/var-tag", function(require, exports, module, __filename, __dirname) { var isValidJavaScriptVarName = require('../../compiler/util/isValidJavaScriptVarName');

module.exports = function nodeFactory(el, context) {
    var builder = context.builder;
    var hasError = false;

    var declarations = el.attributes.map((attr) => {
        var varName = attr.name;

        if (!isValidJavaScriptVarName(varName)) {
            context.addError(el, 'Invalid JavaScript variable name: ' + varName, 'INVALID_VAR_NAME');
            hasError = true;
            return;
        }

        var id = builder.identifier(varName);
        var init = attr.value;

        return {
            id: id,
            init
        };
    });

    if (hasError) {
        return el;
    }

    return context.builder.vars(declarations);
};
});
$rmod.def("/marko@3.3.0/taglibs/core/while-tag", function(require, exports, module, __filename, __dirname) { module.exports = function codeGenerator(elNode, codegen) {
    var argument = elNode.argument;
    if (!argument) {
        codegen.addError('Invalid <while> tag. Argument is missing. Example: <while(i < 4)>');
        return elNode;
    }

    var builder = codegen.builder;

    return builder.whileStatement(builder.parseExpression(argument), elNode.body);
};
});
$rmod.def("/marko@3.3.0/taglibs/html/html-comment-tag", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

'use strict';
module.exports = function render(input, out) {
    out.write('<!--');
    if (input.renderBody) {
        input.renderBody(out);
    }
    out.write('-->');
};

});
$rmod.def("/marko@3.3.0/taglibs/layout/placeholder-tag", function(require, exports, module, __filename, __dirname) { module.exports = function render(input, out) {
    var contentMap = input.content;
    var content = contentMap ? contentMap[input.name] : null;
    if (content) {
        if (content.value) {
            out.write(content.value);
        } else if (content.renderBody) {
            content.renderBody(out);
        }
    } else {
        if (input.renderBody) {
            input.renderBody(out);
        }
    }
};
});
$rmod.def("/marko@3.3.0/taglibs/layout/put-tag", function(require, exports, module, __filename, __dirname) { module.exports = function render(input, context) {
    var layout = input.layout;
    var handlePutTag = layout.handlePutTag;
    handlePutTag(input);
};
});
$rmod.def("/marko@3.3.0/taglibs/layout/use-tag-transformer", function(require, exports, module, __filename, __dirname) { 'use strict';

module.exports = function transform(el, context) {
    var argument = el.argument;
    if (!argument) {
        context.addError(el, 'Invalid <layout-use> tag. Expected: <layout-use(template[, data]) ...>');
        return;
    }
    var builder = context.builder;

    var args = builder.parseJavaScriptArgs(argument);
    var template = args[0];

    if (template.type === 'Literal') {
        template = context.importTemplate(template.value);
    }

    if (args[1]) {
        el.setAttributeValue('__data', args[1]);
    }

    el.argument = null;

    el.setAttributeValue('__template', template);
};
});
$rmod.def("/marko@3.3.0/taglibs/layout/use-tag", function(require, exports, module, __filename, __dirname) { module.exports = function render(input, context) {
    var content = {};

    if (input.getContent) {
        input.getContent({
            handlePutTag: function (putTag) {
                content[putTag.into] = putTag;
            }
        });
    }

    var dataArg = input.__data;
    var templateData = input['*'] || {};

    if (dataArg) {
        for (var k in dataArg) {
            if (dataArg.hasOwnProperty(k) && !templateData.hasOwnProperty(k)) {
                templateData[k] = dataArg[k];
            }
        }
    }
    templateData.layoutContent = content;
    input.__template.render(templateData, context);
};
});
$rmod.main("/assert@1.4.0", "assert");
$rmod.dep("", "assert", "1.4.0");
$rmod.main("/util@0.10.3", "util");
$rmod.dep("", "util", "0.10.3");
$rmod.remap("/util@0.10.3/support/isBuffer", "isBufferBrowser");
$rmod.def("/util@0.10.3/support/isBufferBrowser", function(require, exports, module, __filename, __dirname) { module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
});
$rmod.main("/inherits@2.0.1", "inherits");
$rmod.dep("", "inherits", "2.0.1");
$rmod.remap("/inherits@2.0.1/inherits", "inherits_browser");
$rmod.def("/inherits@2.0.1/inherits_browser", function(require, exports, module, __filename, __dirname) { if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

});
$rmod.def("/util@0.10.3/util", function(require, exports, module, __filename, __dirname) { var process=require("process"); // Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('/$/inherits'/*'inherits'*/);

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

});
$rmod.main("/buffer@4.6.0", "index");
$rmod.dep("", "buffer", "4.6.0");
$rmod.main("/base64-js@1.1.2", "lib/b64");
$rmod.dep("/$/buffer", "base64-js", "1.1.2");
$rmod.def("/base64-js@1.1.2/lib/b64", function(require, exports, module, __filename, __dirname) { 'use strict'

exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

function init () {
  var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (var i = 0, len = code.length; i < len; ++i) {
    lookup[i] = code[i]
    revLookup[code.charCodeAt(i)] = i
  }

  revLookup['-'.charCodeAt(0)] = 62
  revLookup['_'.charCodeAt(0)] = 63
}

init()

function toByteArray (b64) {
  var i, j, l, tmp, placeHolders, arr
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // the number of equal signs (place holders)
  // if there are two placeholders, than the two characters before it
  // represent one byte
  // if there is only one, then the three characters before it represent 2 bytes
  // this is just a cheap hack to not do indexOf twice
  placeHolders = b64[len - 2] === '=' ? 2 : b64[len - 1] === '=' ? 1 : 0

  // base64 is 4/3 + up to two characters of the original data
  arr = new Arr(len * 3 / 4 - placeHolders)

  // if there are placeholders, only get up to the last complete 4 chars
  l = placeHolders > 0 ? len - 4 : len

  var L = 0

  for (i = 0, j = 0; i < l; i += 4, j += 3) {
    tmp = (revLookup[b64.charCodeAt(i)] << 18) | (revLookup[b64.charCodeAt(i + 1)] << 12) | (revLookup[b64.charCodeAt(i + 2)] << 6) | revLookup[b64.charCodeAt(i + 3)]
    arr[L++] = (tmp >> 16) & 0xFF
    arr[L++] = (tmp >> 8) & 0xFF
    arr[L++] = tmp & 0xFF
  }

  if (placeHolders === 2) {
    tmp = (revLookup[b64.charCodeAt(i)] << 2) | (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[L++] = tmp & 0xFF
  } else if (placeHolders === 1) {
    tmp = (revLookup[b64.charCodeAt(i)] << 10) | (revLookup[b64.charCodeAt(i + 1)] << 4) | (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[L++] = (tmp >> 8) & 0xFF
    arr[L++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] + lookup[num >> 12 & 0x3F] + lookup[num >> 6 & 0x3F] + lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var output = ''
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    output += lookup[tmp >> 2]
    output += lookup[(tmp << 4) & 0x3F]
    output += '=='
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + (uint8[len - 1])
    output += lookup[tmp >> 10]
    output += lookup[(tmp >> 4) & 0x3F]
    output += lookup[(tmp << 2) & 0x3F]
    output += '='
  }

  parts.push(output)

  return parts.join('')
}

});
$rmod.main("/ieee754@1.1.6", "index");
$rmod.dep("", "ieee754", "1.1.6");
$rmod.def("/ieee754@1.1.6/index", function(require, exports, module, __filename, __dirname) { exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

});
$rmod.main("/isarray@1.0.0", "index");
$rmod.dep("", "isarray", "1.0.0");
$rmod.def("/isarray@1.0.0/index", function(require, exports, module, __filename, __dirname) { var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};

});
$rmod.def("/buffer@4.6.0/index", function(require, exports, module, __filename, __dirname) { /*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('/$/buffer/$/base64-js'/*'base64-js'*/)
var ieee754 = require('/$/ieee754'/*'ieee754'*/)
var isArray = require('/$/isarray'/*'isarray'*/)

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * Due to various browser bugs, sometimes the Object implementation will be used even
 * when the browser supports typed arrays.
 *
 * Note:
 *
 *   - Firefox 4-29 lacks support for adding new properties to `Uint8Array` instances,
 *     See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
 *
 *   - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
 *
 *   - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
 *     incorrect length in some situations.

 * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they
 * get the Object implementation, which is slower but behaves correctly.
 */
Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined
  ? global.TYPED_ARRAY_SUPPORT
  : typedArraySupport()

/*
 * Export kMaxLength after typed array support is determined.
 */
exports.kMaxLength = kMaxLength()

function typedArraySupport () {
  try {
    var arr = new Uint8Array(1)
    arr.foo = function () { return 42 }
    return arr.foo() === 42 && // typed array instances can be augmented
        typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
        arr.subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
  } catch (e) {
    return false
  }
}

function kMaxLength () {
  return Buffer.TYPED_ARRAY_SUPPORT
    ? 0x7fffffff
    : 0x3fffffff
}

function createBuffer (that, length) {
  if (kMaxLength() < length) {
    throw new RangeError('Invalid typed array length')
  }
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = new Uint8Array(length)
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    if (that === null) {
      that = new Buffer(length)
    }
    that.length = length
  }

  return that
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  if (!Buffer.TYPED_ARRAY_SUPPORT && !(this instanceof Buffer)) {
    return new Buffer(arg, encodingOrOffset, length)
  }

  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new Error(
        'If encoding is specified then the first argument must be a string'
      )
    }
    return allocUnsafe(this, arg)
  }
  return from(this, arg, encodingOrOffset, length)
}

Buffer.poolSize = 8192 // not used by this implementation

// TODO: Legacy, not needed anymore. Remove in next major version.
Buffer._augment = function (arr) {
  arr.__proto__ = Buffer.prototype
  return arr
}

function from (that, value, encodingOrOffset, length) {
  if (typeof value === 'number') {
    throw new TypeError('"value" argument must not be a number')
  }

  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    return fromArrayBuffer(that, value, encodingOrOffset, length)
  }

  if (typeof value === 'string') {
    return fromString(that, value, encodingOrOffset)
  }

  return fromObject(that, value)
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(null, value, encodingOrOffset, length)
}

if (Buffer.TYPED_ARRAY_SUPPORT) {
  Buffer.prototype.__proto__ = Uint8Array.prototype
  Buffer.__proto__ = Uint8Array
  if (typeof Symbol !== 'undefined' && Symbol.species &&
      Buffer[Symbol.species] === Buffer) {
    // Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
    Object.defineProperty(Buffer, Symbol.species, {
      value: null,
      configurable: true
    })
  }
}

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be a number')
  }
}

function alloc (that, size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(that, size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(that, size).fill(fill, encoding)
      : createBuffer(that, size).fill(fill)
  }
  return createBuffer(that, size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(null, size, fill, encoding)
}

function allocUnsafe (that, size) {
  assertSize(size)
  that = createBuffer(that, size < 0 ? 0 : checked(size) | 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) {
    for (var i = 0; i < size; i++) {
      that[i] = 0
    }
  }
  return that
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(null, size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(null, size)
}

function fromString (that, string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('"encoding" must be a valid string encoding')
  }

  var length = byteLength(string, encoding) | 0
  that = createBuffer(that, length)

  that.write(string, encoding)
  return that
}

function fromArrayLike (that, array) {
  var length = checked(array.length) | 0
  that = createBuffer(that, length)
  for (var i = 0; i < length; i += 1) {
    that[i] = array[i] & 255
  }
  return that
}

function fromArrayBuffer (that, array, byteOffset, length) {
  array.byteLength // this throws if `array` is not a valid ArrayBuffer

  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('\'offset\' is out of bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('\'length\' is out of bounds')
  }

  if (length === undefined) {
    array = new Uint8Array(array, byteOffset)
  } else {
    array = new Uint8Array(array, byteOffset, length)
  }

  if (Buffer.TYPED_ARRAY_SUPPORT) {
    // Return an augmented `Uint8Array` instance, for best performance
    that = array
    that.__proto__ = Buffer.prototype
  } else {
    // Fallback: Return an object instance of the Buffer class
    that = fromArrayLike(that, array)
  }
  return that
}

function fromObject (that, obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    that = createBuffer(that, len)

    if (that.length === 0) {
      return that
    }

    obj.copy(that, 0, 0, len)
    return that
  }

  if (obj) {
    if ((typeof ArrayBuffer !== 'undefined' &&
        obj.buffer instanceof ArrayBuffer) || 'length' in obj) {
      if (typeof obj.length !== 'number' || isnan(obj.length)) {
        return createBuffer(that, 0)
      }
      return fromArrayLike(that, obj)
    }

    if (obj.type === 'Buffer' && isArray(obj.data)) {
      return fromArrayLike(that, obj.data)
    }
  }

  throw new TypeError('First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object.')
}

function checked (length) {
  // Note: cannot use `length < kMaxLength` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= kMaxLength()) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + kMaxLength().toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return !!(b != null && b._isBuffer)
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; i++) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var buf = list[i]
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (typeof ArrayBuffer !== 'undefined' && typeof ArrayBuffer.isView === 'function' &&
      (ArrayBuffer.isView(string) || string instanceof ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    string = '' + string
  }

  var len = string.length
  if (len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'binary':
      // Deprecated
      case 'raw':
      case 'raws':
        return len
      case 'utf8':
      case 'utf-8':
      case undefined:
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) return utf8ToBytes(string).length // assume utf8
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'binary':
        return binarySlice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// The property is used by `Buffer.isBuffer` and `is-buffer` (in Safari 5-7) to detect
// Buffer instances.
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length | 0
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (!Buffer.isBuffer(target)) {
    throw new TypeError('Argument must be a Buffer')
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

function arrayIndexOf (arr, val, byteOffset, encoding) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var foundIndex = -1
  for (var i = 0; byteOffset + i < arrLength; i++) {
    if (read(arr, byteOffset + i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
      if (foundIndex === -1) foundIndex = i
      if (i - foundIndex + 1 === valLength) return (byteOffset + foundIndex) * indexSize
    } else {
      if (foundIndex !== -1) i -= i - foundIndex
      foundIndex = -1
    }
  }
  return -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset >>= 0

  if (this.length === 0) return -1
  if (byteOffset >= this.length) return -1

  // Negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = Math.max(this.length + byteOffset, 0)

  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  if (Buffer.isBuffer(val)) {
    // special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(this, val, byteOffset, encoding)
  }
  if (typeof val === 'number') {
    if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
      return Uint8Array.prototype.indexOf.call(this, val, byteOffset)
    }
    return arrayIndexOf(this, [ val ], byteOffset, encoding)
  }

  throw new TypeError('val must be string, number or Buffer')
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  if (strLen % 2 !== 0) throw new Error('Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (isNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function binaryWrite (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset | 0
    if (isFinite(length)) {
      length = length | 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  // legacy write(string, encoding, offset, length) - remove in v0.13
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'binary':
        return binaryWrite(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
      : (firstByte > 0xBF) ? 2
      : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function binarySlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    newBuf = this.subarray(start, end)
    newBuf.__proto__ = Buffer.prototype
  } else {
    var sliceLen = end - start
    newBuf = new Buffer(sliceLen, undefined)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
  }

  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  byteLength = byteLength | 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  this[offset] = (value & 0xff)
  return offset + 1
}

function objectWriteUInt16 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
    buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
      (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

function objectWriteUInt32 (buf, value, offset, littleEndian) {
  if (value < 0) value = 0xffffffff + value + 1
  for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
    buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset + 3] = (value >>> 24)
    this[offset + 2] = (value >>> 16)
    this[offset + 1] = (value >>> 8)
    this[offset] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) {
    var limit = Math.pow(2, 8 * byteLength - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
  } else {
    objectWriteUInt16(this, value, offset, true)
  }
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 8)
    this[offset + 1] = (value & 0xff)
  } else {
    objectWriteUInt16(this, value, offset, false)
  }
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value & 0xff)
    this[offset + 1] = (value >>> 8)
    this[offset + 2] = (value >>> 16)
    this[offset + 3] = (value >>> 24)
  } else {
    objectWriteUInt32(this, value, offset, true)
  }
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset | 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  if (Buffer.TYPED_ARRAY_SUPPORT) {
    this[offset] = (value >>> 24)
    this[offset + 1] = (value >>> 16)
    this[offset + 2] = (value >>> 8)
    this[offset + 3] = (value & 0xff)
  } else {
    objectWriteUInt32(this, value, offset, false)
  }
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start
  var i

  if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (i = len - 1; i >= 0; i--) {
      target[i + targetStart] = this[i + start]
    }
  } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
    // ascending copy from start
    for (i = 0; i < len; i++) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, start + len),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if (code < 256) {
        val = code
      }
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; i++) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : utf8ToBytes(new Buffer(val, encoding).toString())
    var len = bytes.length
    for (i = 0; i < end - start; i++) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = stringtrim(str).replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; i++) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

function isnan (val) {
  return val !== val // eslint-disable-line no-self-compare
}

});
$rmod.main("/buffer-shims@1.0.0", "index");
$rmod.dep("", "buffer-shims", "1.0.0");
$rmod.def("/buffer-shims@1.0.0/index", function(require, exports, module, __filename, __dirname) { 'use strict';

var buffer = require('/$/buffer'/*'buffer'*/);
var Buffer = buffer.Buffer;
var SlowBuffer = buffer.SlowBuffer;
var MAX_LEN = buffer.kMaxLength || 2147483647;
exports.alloc = function alloc(size, fill, encoding) {
  if (typeof Buffer.alloc === 'function') {
    return Buffer.alloc(size, fill, encoding);
  }
  if (typeof encoding === 'number') {
    throw new TypeError('encoding must not be number');
  }
  if (typeof size !== 'number') {
    throw new TypeError('size must be a number');
  }
  if (size > MAX_LEN) {
    throw new RangeError('size is too large');
  }
  var enc = encoding;
  var _fill = fill;
  if (_fill === undefined) {
    enc = undefined;
    _fill = 0;
  }
  var buf = new Buffer(size);
  if (typeof _fill === 'string') {
    var fillBuf = new Buffer(_fill, enc);
    var flen = fillBuf.length;
    var i = -1;
    while (++i < size) {
      buf[i] = fillBuf[i % flen];
    }
  } else {
    buf.fill(_fill);
  }
  return buf;
}
exports.allocUnsafe = function allocUnsafe(size) {
  if (typeof Buffer.allocUnsafe === 'function') {
    return Buffer.allocUnsafe(size);
  }
  if (typeof size !== 'number') {
    throw new TypeError('size must be a number');
  }
  if (size > MAX_LEN) {
    throw new RangeError('size is too large');
  }
  return new Buffer(size);
}
exports.from = function from(value, encodingOrOffset, length) {
  if (typeof Buffer.from === 'function' && (!global.Uint8Array || Uint8Array.from !== Buffer.from)) {
    return Buffer.from(value, encodingOrOffset, length);
  }
  if (typeof value === 'number') {
    throw new TypeError('"value" argument must not be a number');
  }
  if (typeof value === 'string') {
    return new Buffer(value, encodingOrOffset);
  }
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
    var offset = encodingOrOffset;
    if (arguments.length === 1) {
      return new Buffer(value);
    }
    if (typeof offset === 'undefined') {
      offset = 0;
    }
    var len = length;
    if (typeof len === 'undefined') {
      len = value.byteLength - offset;
    }
    if (offset >= value.byteLength) {
      throw new RangeError('\'offset\' is out of bounds');
    }
    if (len > value.byteLength - offset) {
      throw new RangeError('\'length\' is out of bounds');
    }
    return new Buffer(value.slice(offset, offset + len));
  }
  if (Buffer.isBuffer(value)) {
    var out = new Buffer(value.length);
    value.copy(out, 0, 0, value.length);
    return out;
  }
  if (value) {
    if (Array.isArray(value) || (typeof ArrayBuffer !== 'undefined' && value.buffer instanceof ArrayBuffer) || 'length' in value) {
      return new Buffer(value);
    }
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
      return new Buffer(value.data);
    }
  }

  throw new TypeError('First argument must be a string, Buffer, ' + 'ArrayBuffer, Array, or array-like object.');
}
exports.allocUnsafeSlow = function allocUnsafeSlow(size) {
  if (typeof Buffer.allocUnsafeSlow === 'function') {
    return Buffer.allocUnsafeSlow(size);
  }
  if (typeof size !== 'number') {
    throw new TypeError('size must be a number');
  }
  if (size >= MAX_LEN) {
    throw new RangeError('size is too large');
  }
  return new SlowBuffer(size);
}

});
$rmod.def("/assert@1.4.0/assert", function(require, exports, module, __filename, __dirname) { // http://wiki.commonjs.org/wiki/Unit_Testing/1.0
//
// THIS IS NOT TESTED NOR LIKELY TO WORK OUTSIDE V8!
//
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// UTILITY
function compare(bufa, bufb) {
  var cmpLen = Math.min(bufa, bufb);
  if (cmpLen <= 0) {
    return 0;
  }
  var i = -1;
  var a,b;
  while (++i < cmpLen) {
    a = bufa[i];
    b = bufb[i];
    if (a < b) {
      return -1;
    } else if (a > b) {
      return 1;
    }
  }
  return 0;
}
var util = require('/$/util'/*'util/'*/);
var Buffer = require('/$/buffer'/*'buffer'*/).Buffer;
var BufferShim = require('/$/buffer-shims'/*'buffer-shims'*/);
var hasOwn = Object.prototype.hasOwnProperty;
var pSlice = Array.prototype.slice;
var functionsHaveNames = (function () {
  return function foo() {}.name === 'foo';
}());
function pToString (obj) {
  return Object.prototype.toString.call(obj);
}
function isView(arrbuf) {
  if (typeof global.ArrayBuffer !== 'function') {
    return false;
  }
  if (typeof ArrayBuffer.isView === 'function') {
    return ArrayBuffer.isView(arrbuf);
  }
  if (!arrbuf) {
    return false;
  }
  if (arrbuf instanceof DataView) {
    return true;
  }
  if (arrbuf.buffer && arrbuf.buffer instanceof ArrayBuffer) {
    return true;
  }
  return false;
}
// 1. The assert module provides functions that throw
// AssertionError's when particular conditions are not met. The
// assert module must conform to the following interface.

var assert = module.exports = ok;

// 2. The AssertionError is defined in assert.
// new assert.AssertionError({ message: message,
//                             actual: actual,
//                             expected: expected })

var regex = /\s*function\s+([^\(\s]*)\s*/;
// based on https://github.com/ljharb/function.prototype.name/blob/adeeeec8bfcc6068b187d7d9fb3d5bb1d3a30899/implementation.js
function getName(func) {
  if (!util.isFunction(func)) {
    return;
  }
  if (functionsHaveNames) {
    return func.name;
  }
  var str = func.toString();
  var match = str.match(regex);
  return match && match[1];
}
assert.AssertionError = function AssertionError(options) {
  this.name = 'AssertionError';
  this.actual = options.actual;
  this.expected = options.expected;
  this.operator = options.operator;
  if (options.message) {
    this.message = options.message;
    this.generatedMessage = false;
  } else {
    this.message = getMessage(this);
    this.generatedMessage = true;
  }
  var stackStartFunction = options.stackStartFunction || fail;
  if (Error.captureStackTrace) {
   Error.captureStackTrace(this, stackStartFunction);
 } else {
   // non v8 browsers so we can have a stacktrace
   var err = new Error();
   if (err.stack) {
     var out = err.stack;

     // try to strip useless frames
     var fn_name = getName(stackStartFunction);
     var idx = out.indexOf('\n' + fn_name);
     if (idx >= 0) {
       // once we have located the function frame
       // we need to strip out everything before it (and its line)
       var next_line = out.indexOf('\n', idx + 1);
       out = out.substring(next_line + 1);
     }

     this.stack = out;
   }
  }
};

// assert.AssertionError instanceof Error
util.inherits(assert.AssertionError, Error);

function truncate(s, n) {
  if (typeof s === 'string') {
    return s.length < n ? s : s.slice(0, n);
  } else {
    return s;
  }
}
function inspect(something) {
  if (functionsHaveNames || !util.isFunction(something)) {
    return util.inspect(something);
  }
  var rawname = getName(something);
  var name = rawname ? ': ' + rawname : '';
  return '[Function' +  name + ']';
}
function getMessage(self) {
  return truncate(inspect(self.actual), 128) + ' ' +
         self.operator + ' ' +
         truncate(inspect(self.expected), 128);
}

// At present only the three keys mentioned above are used and
// understood by the spec. Implementations or sub modules can pass
// other keys to the AssertionError's constructor - they will be
// ignored.

// 3. All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided.  All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes.

function fail(actual, expected, message, operator, stackStartFunction) {
  throw new assert.AssertionError({
    message: message,
    actual: actual,
    expected: expected,
    operator: operator,
    stackStartFunction: stackStartFunction
  });
}

// EXTENSION! allows for well behaved errors defined elsewhere.
assert.fail = fail;

// 4. Pure assertion tests whether a value is truthy, as determined
// by !!guard.
// assert.ok(guard, message_opt);
// This statement is equivalent to assert.equal(true, !!guard,
// message_opt);. To test strictly for the value true, use
// assert.strictEqual(true, guard, message_opt);.

function ok(value, message) {
  if (!value) fail(value, true, message, '==', assert.ok);
}
assert.ok = ok;

// 5. The equality assertion tests shallow, coercive equality with
// ==.
// assert.equal(actual, expected, message_opt);

assert.equal = function equal(actual, expected, message) {
  if (actual != expected) fail(actual, expected, message, '==', assert.equal);
};

// 6. The non-equality assertion tests for whether two objects are not equal
// with != assert.notEqual(actual, expected, message_opt);

assert.notEqual = function notEqual(actual, expected, message) {
  if (actual == expected) {
    fail(actual, expected, message, '!=', assert.notEqual);
  }
};

// 7. The equivalence assertion tests a deep equality relation.
// assert.deepEqual(actual, expected, message_opt);

assert.deepEqual = function deepEqual(actual, expected, message) {
  if (!_deepEqual(actual, expected, false)) {
    fail(actual, expected, message, 'deepEqual', assert.deepEqual);
  }
};

assert.deepStrictEqual = function deepStrictEqual(actual, expected, message) {
  if (!_deepEqual(actual, expected, true)) {
    fail(actual, expected, message, 'deepStrictEqual', assert.deepStrictEqual);
  }
};

function _deepEqual(actual, expected, strict, memos) {
  // 7.1. All identical values are equivalent, as determined by ===.
  if (actual === expected) {
    return true;
  } else if (Buffer.isBuffer(actual) && Buffer.isBuffer(expected)) {
    return compare(actual, expected) === 0;

  // 7.2. If the expected value is a Date object, the actual value is
  // equivalent if it is also a Date object that refers to the same time.
  } else if (util.isDate(actual) && util.isDate(expected)) {
    return actual.getTime() === expected.getTime();

  // 7.3 If the expected value is a RegExp object, the actual value is
  // equivalent if it is also a RegExp object with the same source and
  // properties (`global`, `multiline`, `lastIndex`, `ignoreCase`).
  } else if (util.isRegExp(actual) && util.isRegExp(expected)) {
    return actual.source === expected.source &&
           actual.global === expected.global &&
           actual.multiline === expected.multiline &&
           actual.lastIndex === expected.lastIndex &&
           actual.ignoreCase === expected.ignoreCase;

  // 7.4. Other pairs that do not both pass typeof value == 'object',
  // equivalence is determined by ==.
  } else if ((actual === null || typeof actual !== 'object') &&
             (expected === null || typeof expected !== 'object')) {
    return strict ? actual === expected : actual == expected;

  // If both values are instances of typed arrays, wrap their underlying
  // ArrayBuffers in a Buffer each to increase performance
  // This optimization requires the arrays to have the same type as checked by
  // Object.prototype.toString (aka pToString). Never perform binary
  // comparisons for Float*Arrays, though, since e.g. +0 === -0 but their
  // bit patterns are not identical.
  } else if (isView(actual) && isView(expected) &&
             pToString(actual) === pToString(expected) &&
             !(actual instanceof Float32Array ||
               actual instanceof Float64Array)) {
    return compare(BufferShim.from(actual.buffer),
                   BufferShim.from(expected.buffer)) === 0;

  // 7.5 For all other Object pairs, including Array objects, equivalence is
  // determined by having the same number of owned properties (as verified
  // with Object.prototype.hasOwnProperty.call), the same set of keys
  // (although not necessarily the same order), equivalent values for every
  // corresponding key, and an identical 'prototype' property. Note: this
  // accounts for both named and indexed properties on Arrays.
  } else {
    memos = memos || {actual: [], expected: []};

    var actualIndex = memos.actual.indexOf(actual);
    if (actualIndex !== -1) {
      if (actualIndex === memos.expected.indexOf(expected)) {
        return true;
      }
    }

    memos.actual.push(actual);
    memos.expected.push(expected);

    return objEquiv(actual, expected, strict, memos);
  }
}

function isArguments(object) {
  return Object.prototype.toString.call(object) == '[object Arguments]';
}

function objEquiv(a, b, strict, actualVisitedObjects) {
  if (a === null || a === undefined || b === null || b === undefined)
    return false;
  // if one is a primitive, the other must be same
  if (util.isPrimitive(a) || util.isPrimitive(b))
    return a === b;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b))
    return false;
  var aIsArgs = isArguments(a);
  var bIsArgs = isArguments(b);
  if ((aIsArgs && !bIsArgs) || (!aIsArgs && bIsArgs))
    return false;
  if (aIsArgs) {
    a = pSlice.call(a);
    b = pSlice.call(b);
    return _deepEqual(a, b, strict);
  }
  var ka = objectKeys(a);
  var kb = objectKeys(b);
  var key, i;
  // having the same number of owned properties (keys incorporates
  // hasOwnProperty)
  if (ka.length !== kb.length)
    return false;
  //the same set of keys (although not necessarily the same order),
  ka.sort();
  kb.sort();
  //~~~cheap key test
  for (i = ka.length - 1; i >= 0; i--) {
    if (ka[i] !== kb[i])
      return false;
  }
  //equivalent values for every corresponding key, and
  //~~~possibly expensive deep test
  for (i = ka.length - 1; i >= 0; i--) {
    key = ka[i];
    if (!_deepEqual(a[key], b[key], strict, actualVisitedObjects))
      return false;
  }
  return true;
}

// 8. The non-equivalence assertion tests for any deep inequality.
// assert.notDeepEqual(actual, expected, message_opt);

assert.notDeepEqual = function notDeepEqual(actual, expected, message) {
  if (_deepEqual(actual, expected, false)) {
    fail(actual, expected, message, 'notDeepEqual', assert.notDeepEqual);
  }
};

assert.notDeepStrictEqual = notDeepStrictEqual;
function notDeepStrictEqual(actual, expected, message) {
  if (_deepEqual(actual, expected, true)) {
    fail(actual, expected, message, 'notDeepStrictEqual', notDeepStrictEqual);
  }
}


// 9. The strict equality assertion tests strict equality, as determined by ===.
// assert.strictEqual(actual, expected, message_opt);

assert.strictEqual = function strictEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(actual, expected, message, '===', assert.strictEqual);
  }
};

// 10. The strict non-equality assertion tests for strict inequality, as
// determined by !==.  assert.notStrictEqual(actual, expected, message_opt);

assert.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (actual === expected) {
    fail(actual, expected, message, '!==', assert.notStrictEqual);
  }
};

function expectedException(actual, expected) {
  if (!actual || !expected) {
    return false;
  }

  if (Object.prototype.toString.call(expected) == '[object RegExp]') {
    return expected.test(actual);
  }

  try {
    if (actual instanceof expected) {
      return true;
    }
  } catch (e) {
    // Ignore.  The instanceof check doesn't work for arrow functions.
  }

  if (Error.isPrototypeOf(expected)) {
    return false;
  }

  return expected.call({}, actual) === true;
}

function _tryBlock(block) {
  var error;
  try {
    block();
  } catch (e) {
    error = e;
  }
  return error;
}

function _throws(shouldThrow, block, expected, message) {
  var actual;

  if (typeof block !== 'function') {
    throw new TypeError('"block" argument must be a function');
  }

  if (typeof expected === 'string') {
    message = expected;
    expected = null;
  }

  actual = _tryBlock(block);

  message = (expected && expected.name ? ' (' + expected.name + ').' : '.') +
            (message ? ' ' + message : '.');

  if (shouldThrow && !actual) {
    fail(actual, expected, 'Missing expected exception' + message);
  }

  var userProvidedMessage = typeof message === 'string';
  var isUnwantedException = !shouldThrow && util.isError(actual);
  var isUnexpectedException = !shouldThrow && actual && !expected;

  if ((isUnwantedException &&
      userProvidedMessage &&
      expectedException(actual, expected)) ||
      isUnexpectedException) {
    fail(actual, expected, 'Got unwanted exception' + message);
  }

  if ((shouldThrow && actual && expected &&
      !expectedException(actual, expected)) || (!shouldThrow && actual)) {
    throw actual;
  }
}

// 11. Expected to throw an error:
// assert.throws(block, Error_opt, message_opt);

assert.throws = function(block, /*optional*/error, /*optional*/message) {
  _throws(true, block, error, message);
};

// EXTENSION! This is annoying to write outside this module.
assert.doesNotThrow = function(block, /*optional*/error, /*optional*/message) {
  _throws(false, block, error, message);
};

assert.ifError = function(err) { if (err) throw err; };

var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    if (hasOwn.call(obj, key)) keys.push(key);
  }
  return keys;
};

});
$rmod.def("/marko@3.3.0/compiler/ast/ArrayContainer", function(require, exports, module, __filename, __dirname) { 'use strict';

var ok = require('/$/assert'/*'assert'*/).ok;
var isArray = Array.isArray;
var Container = require('./Container');

class ArrayContainer extends Container {
    constructor(node, array) {
        super(node);
        this.items = array;
    }

    forEach(callback, thisObj) {
        var array = this.array.concat([]);
        for (var i=0; i<array.length; i++) {
            var item = array[i];
            if (item.container === this) {
                callback.call(thisObj, item, i);
            }
        }
    }

    replaceChild(newChild, oldChild) {
        ok(newChild, '"newChild" is required"');

        var array = this.array;
        var len = array.length;
        for (var i=0; i<len; i++) {
            var curChild = array[i];
            if (curChild === oldChild) {
                array[i] = newChild;
                oldChild.detach();
                newChild.container = this;
                return true;
            }
        }

        return false;
    }

    removeChild(child) {
        var childIndex = this.array.indexOf(child);
        if (childIndex !== -1) {
            this.array.splice(childIndex, 1);
            child.detach();
            return true;
        } else {
            return false;
        }
    }

    prependChild(newChild) {
        ok(newChild, '"newChild" is required"');
        this.array.unshift(newChild);
        newChild.container = this;
    }

    appendChild(newChild) {
        ok(newChild, '"newChild" is required"');
        newChild.detach();
        this.array.push(newChild);
        newChild.container = this;
    }

    insertChildBefore(newChild, referenceNode) {
        ok(newChild, '"newChild" is required"');
        ok(referenceNode, 'Invalid reference child');

        var array = this.array;
        var len = array.length;
        for (var i=0; i<len; i++) {
            var curChild = array[i];
            if (curChild === referenceNode) {
                array.splice(i, 0, newChild);
                newChild.container = this;
                return;
            }
        }

        throw new Error('Reference node not found');
    }

    insertChildAfter(newChild, referenceNode) {
        ok(newChild, '"newChild" is required"');
        ok(referenceNode, 'Invalid reference child');

        var array = this.array;
        var len = array.length;
        for (var i=0; i<len; i++) {
            var curChild = array[i];
            if (curChild === referenceNode) {
                array.splice(i+1, 0, newChild);
                newChild.container = this;
                return;
            }
        }

        throw new Error('Reference node not found');
    }

    moveChildrenTo(target) {
        ok(target.appendChild, 'Node does not support appendChild(node): ' + target);

        var array = this.array;
        var len = array.length;
        for (var i=0; i<len; i++) {
            var curChild = array[i];
            curChild.container = null; // Detach the child from this container
            target.appendChild(curChild);
        }

        this.array.length = 0; // Clear out this container
    }

    getPreviousSibling(node) {
        if (node.container !== this) {
            throw new Error('Node does not belong to container: ' + node);
        }
        var array = this.array;

        for (var i=0; i<array.length; i++) {
            var curNode = array[i];
            if (curNode.container !== this) {
                continue;
            }

            if (curNode === node) {
                return i-1 >= 0 ? array[i+1] : undefined;
            }
        }
    }

    getNextSibling(node) {
        if (node.container !== this) {
            throw new Error('Node does not belong to container: ' + node);
        }
        var array = this.array;

        for (var i=0; i<array.length; i++) {
            var curNode = array[i];
            if (curNode.container !== this) {
                continue;
            }

            if (curNode === node) {
                return i+1 < array.length ? array[i+1] : undefined;
            }
        }
    }

    forEachNextSibling(node, callback, thisObj) {
        if (node.container !== this) {
            throw new Error('Node does not belong to container: ' + node);
        }
        var array = this.array.concat([]);
        var found = false;

        for (var i=0; i<array.length; i++) {
            var curNode = array[i];
            if (curNode.container !== this) {
                continue;
            }
            if (found) {
                if (curNode.container === this) {
                    var keepGoing = callback.call(thisObj, curNode) !== false;
                    if (!keepGoing) {
                        return;
                    }
                }
            } else if (curNode === node) {
                found = true;
                continue;
            }
        }
    }

    get length() {
        return this.array.length;
    }

    get items() {
        return this.array;
    }

    set items(newItems) {
        if (newItems) {
            ok(isArray(newItems), 'Invalid array');

            for (let i=0; i<newItems.length; i++) {
                newItems[i].container = this;
            }
        }
        this.array = newItems || [];
    }
}

module.exports = ArrayContainer;
});
$rmod.def("/marko@3.3.0/compiler/ast/Node", function(require, exports, module, __filename, __dirname) { 'use strict';
var Container = require('./Container');
var ArrayContainer = require('./ArrayContainer');
var ok = require('/$/assert'/*'assert'*/).ok;
var extend = require('/$/raptor-util/extend'/*'raptor-util/extend'*/);
var inspect = require('/$/util'/*'util'*/).inspect;
var EventEmitter = require('/$/events'/*'events'*/).EventEmitter;

function trim(textNode) {
    if (textNode.preserveWhitespace === true) {
        return;
    }

    var text = textNode.argument.value;
    var isFirst = textNode.isFirst;
    var isLast = textNode.isLast;

    if (isFirst) {
        //First child
        text = text.replace(/^\n\s*/g, '');
    }
    if (isLast) {
        //Last child
        text = text.replace(/\n\s*$/g, '');
    }
    if (/^\n\s*$/.test(text)) {
        //Whitespace between elements
        text = '';
    }
    text = text.replace(/\s+/g, ' ');
    textNode.argument.value = text;
}

class Node {
    constructor(type) {
        this.type = type;
        this.statement = false;
        this.container = null;
        this.pos = null; // The character index of the node in the original source file
        this.tagDef = null; // The tag definition associated with this Node
        this._codeGeneratorFuncs = null;
        this._flags = {};
        this._transformersApplied = {};
        this._preserveWhitespace = null;
        this._events = null;
        this._childTextNormalized = undefined;
        this.data = {};
    }

    on(event, listener) {
        if (!this._events) {
            this._events = new EventEmitter();
        }

        this._events.on(event, listener);
    }

    emit(event, args) {
        if (this._events) {
            this._events.emit.apply(this._events, arguments);
        }
    }

    listenerCount(event) {
        if (this._events) {
            return this._events.listenerCount(event);
        } else {
            return 0;
        }
    }

    onBeforeGenerateCode(listener) {
        this.on('beforeGenerateCode', listener);
    }

    onAfterGenerateCode(listener) {
        this.on('afterGenerateCode', listener);
    }

    wrapWith(wrapperNode) {
        ok(this.container, 'Node does not belong to a container: ' + this);
        var replaced = this.container.replaceChild(wrapperNode, this);
        ok(replaced, 'Invalid state. Child does not belong to the container');
        wrapperNode.appendChild(this);
    }

    replaceWith(newNode) {
        ok(this.container, 'Node does not belong to a container: ' + this);
        var replaced = this.container.replaceChild(newNode, this);
        ok(replaced, 'Invalid state. Child does not belong to the container');
    }

    insertSiblingBefore(newNode) {
        ok(this.container, 'Node does not belong to a container: ' + this);
        this.container.insertChildBefore(newNode, this);
    }

    insertSiblingAfter(newNode) {
        ok(this.container, 'Node does not belong to a container: ' + this);
        this.container.insertChildAfter(newNode, this);
    }

    /**
     * Converts the provided `array` into a `ArrayContainer`. If the provided `array` is already an instance of a `Container` then it is simply returned.
     * @param  {[type]} array [description]
     * @return {[type]}       [description]
     */
    makeContainer(array) {
        if (array instanceof Container) {
            return array;
        }

        return new ArrayContainer(this, array);
    }

    prependChild(node) {
        ok(this.body, 'Node does not support child nodes: ' + this);
        this.body.prependChild(node);
    }

    appendChild(node) {
        ok(this.body, 'Node does not support child nodes: ' + this);
        this.body.appendChild(node);
    }

    insertBefore(newNode, referenceNode) {
        ok(this.body, 'Node does not support child nodes: ' + this);
        this.body.insertBefore(newNode, referenceNode);
    }

    forEachChild(callback, thisObj) {
        if (this.body) {
            this.body.forEach(callback, thisObj);
        }
    }

    moveChildrenTo(targetNode) {
        ok(this.body, 'Node does not support child nodes: ' + this);
        ok(this !== targetNode, 'Target node cannot be the same as the source node');

        this.body.moveChildrenTo(targetNode);
    }

    forEachNextSibling(callback, thisObj) {
        var container = this.container;

        if (container) {
            container.forEachNextSibling(this, callback, thisObj);
        }
    }

    get previousSibling() {
        var container = this.container;

        if (container) {
            container.getPreviousSibling(this);
        }
    }

    get nextSibling() {
        var container = this.container;

        if (container) {
            container.getNextSibling(this);
        }
    }

    isTransformerApplied(transformer) {
        return this._transformersApplied[transformer.id] === true;
    }

    setTransformerApplied(transformer) {
        this._transformersApplied[transformer.id] = true;
    }

    toString() {
        return inspect(this);
    }

    toJSON() {
        let result = extend({}, this);
        delete result.container;
        delete result.statement;
        delete result.pos;
        delete result._transformersApplied;
        delete result._codeGeneratorFuncs;
        delete result._flags;
        delete result.data;
        delete result.tagDef;
        delete result._preserveWhitespace;
        delete result._events;
        return result;
    }

    detach() {
        if (this.container) {
            this.container.removeChild(this);
            this.container = null;
        }
    }

    /**
     * Returns true if the current node represents a compound expression (e.g. )
     * @return {Boolean} [description]
     */
    isCompoundExpression() {
        return false;
    }

    isDetached() {
        return this.container == null;
    }

    /**
     * Used by the Node.js require('util').inspect function.
     * We default to inspecting on the simplified version
     * of this node that is the same version we use when
     * serializing to JSON.
     */
    inspect(depth, opts) {
        // We inspect in the simplified version of this object t
        return this.toJSON();
    }

    setType(newType) {
        this.type = newType;
    }

    setCodeGenerator(mode, codeGeneratorFunc) {
        if (arguments.length === 1) {
            codeGeneratorFunc = arguments[0];
            mode = null;
        }

        if (!this._codeGeneratorFuncs) {
            this._codeGeneratorFuncs = {};
        }
        this._codeGeneratorFuncs[mode || 'DEFAULT'] = codeGeneratorFunc;
    }

    getCodeGenerator(mode) {
        if (this._codeGeneratorFuncs) {
            return this._codeGeneratorFuncs[mode] || this._codeGeneratorFuncs.DEFAULT;
        } else {
            return undefined;
        }
    }

    setFlag(name) {
        this._flags[name] = true;
    }

    clearFlag(name) {
        delete this._flags[name];
    }

    isFlagSet(name) {
        return this._flags.hasOwnProperty(name);
    }

    get bodyText() {
        var bodyText = '';

        this.forEachChild((child) => {
            if (child.type === 'Text') {
                var childText = child.argument;
                if (childText && childText.type === 'Literal') {
                    bodyText += childText.value;
                }
            }
        });

        return bodyText;
    }

    get parentNode() {
        return this.container && this.container.node;
    }

    setPreserveWhitespace(isPreserved) {
        this._preserveWhitespace = isPreserved;
    }

    isPreserveWhitespace() {
        var preserveWhitespace = this._preserveWhitespace;
        if (preserveWhitespace == null) {
            preserveWhitespace = this.tagDef && this.tagDef.preserveWhitespace;
        }

        return preserveWhitespace === true;
    }

    _normalizeChildTextNodes(codegen, trimStartEnd, force) {
        if (this._childTextNormalized && force !== true) {
            return;
        }

        this._childTextNormalized = true;

        var isPreserveWhitespace = false;

        if (codegen.context.isPreserveWhitespace() || this.preserveWhitespace === true || this.isPreserveWhitespace()) {
            isPreserveWhitespace = true;
        }

        if (isPreserveWhitespace && trimStartEnd !== true) {
            return;
        }

        var body = this.body;
        if (!body) {
            return;
        }

        var isFirst = true;

        var currentTextLiteral = null;
        var literalTextNodes = [];

        body.forEach((curChild, i) => {
            if (curChild.noOutput) {
                // Skip over AST nodes that produce no HTML output
                return;
            }

            if (curChild.type === 'Text' && curChild.isLiteral()) {
                curChild.isFirst  = null;
                curChild.isLast  = null;

                if (currentTextLiteral &&
                        currentTextLiteral.preserveWhitespace === curChild.preserveWhitespace &&
                        currentTextLiteral.escape === curChild.escape) {
                    currentTextLiteral.argument.value += curChild.argument.value;
                    curChild.detach();
                } else {
                    currentTextLiteral = curChild;
                    literalTextNodes.push(currentTextLiteral);
                    if (isFirst) {
                        currentTextLiteral.isFirst = true;
                    }
                }
            } else {
                currentTextLiteral = null;
            }

            isFirst = false;
        });

        if (currentTextLiteral) {
            // Last child text
            currentTextLiteral.isLast = true;
        }

        if (trimStartEnd) {
            if (literalTextNodes.length) {
                // We will only trim the first and last nodes
                var firstTextNode = literalTextNodes[0];
                var lastTextNode = literalTextNodes[literalTextNodes.length - 1];

                if (firstTextNode.isFirst) {
                    firstTextNode.argument.value = firstTextNode.argument.value.replace(/^\s*/, '');
                }

                if (lastTextNode.isLast) {
                    lastTextNode.argument.value = lastTextNode.argument.value.replace(/\s*$/, '');
                }
            }
        }

        if (!isPreserveWhitespace) {
            literalTextNodes.forEach(trim);
        }
    }
}

module.exports = Node;
});
$rmod.def("/marko@3.3.0/compiler/ast/Literal", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var isArray = Array.isArray;
const isValidJavaScriptVarName = require('../util/isValidJavaScriptVarName');

class Literal extends Node {
    constructor(def) {
        super('Literal');
        this.value = def.value;
    }

    generateCode(codegen) {
        var value = this.value;
        codegen.writeLiteral(value);
    }

    toString() {
        var value = this.value;
        if (value === null) {
            return 'null';
        } else if (value === undefined) {
            return 'undefined';
        } else if (typeof value === 'string') {
            return JSON.stringify(value);
        } else if (value === true) {
            return 'true';
        } else if (value === false) {
            return 'false';
        }  else if (isArray(value)) {
            return '[' + value.join(', ') + ']';
        } else if (typeof value === 'number') {
            return value.toString();
        } else if (typeof value === 'object') {
            let keys = Object.keys(value);
            if (keys.length === 0) {
                return '{}';
            }

            var result = '{ ';

            for (let i=0; i<keys.length; i++) {
                let k = keys[i];
                let v = value[k];

                if (i !== 0) {
                    result += ', ';
                }

                if (isValidJavaScriptVarName(k)) {
                    result += k + ': ';
                } else {
                    result += JSON.stringify(k) + ': ';
                }

                result += v;
            }

            return result + ' }';
        }
    }
}

module.exports = Literal;
});
$rmod.def("/marko@3.3.0/compiler/ast/Identifier", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class Identifier extends Node {
    constructor(def) {
        super('Identifier');
        this.name = def.name;
    }

    generateCode(codegen) {
        var name = this.name;
        codegen.write(name);
    }

    toString() {
        return this.name;
    }
}

module.exports = Identifier;
});
$rmod.def("/marko@3.3.0/compiler/ast/Container", function(require, exports, module, __filename, __dirname) { 'use strict';

class Container {
    constructor(node) {
        this.node = node;
    }

    toJSON() {
        return this.items;
    }
}

module.exports = Container;
});
$rmod.def("/marko@3.3.0/compiler/CodeGenerator", function(require, exports, module, __filename, __dirname) { 'use strict';

const isArray = Array.isArray;
const Node = require('./ast/Node');
const Literal = require('./ast/Literal');
const Identifier = require('./ast/Identifier');
const ok = require('/$/assert'/*'assert'*/).ok;
const Container = require('./ast/Container');
const util = require('/$/util'/*'util'*/);
const isValidJavaScriptVarName = require('./util/isValidJavaScriptVarName');

class GeneratorEvent {
    constructor(node, codegen) {
        this.node = node;
        this.codegen = codegen;

        this.isBefore = true;
        this.builder = codegen.builder;
        this.context = codegen.context;
    }

    insertCode(newCode) {
        this.codegen.generateStatements(newCode);

        if (this.isBefore) {
            if (!this.codegen._code.endsWith(this.codegen.currentIndent)) {
                this.codegen.writeLineIndent();
            }
        }
    }
}

class Slot {
    constructor(codegen, slotNode) {
        this._content = null;

        this._start = codegen._code.length;
        codegen.write('/* slot */');

        if (slotNode.statement) {
            codegen.write('\n');
        }
        this._end = codegen._code.length;

        this.currentIndent = codegen.currentIndent;
        this._inFunction = codegen.inFunction;
        this._statement = slotNode.statement;
    }

    setContent(content) {
        this._content = content;
    }

    generateCode(codegen) {
        let content = this._content;
        let slotCode;

        if (content) {
            let isStatement = this._statement;

            codegen.currentIndent = this.currentIndent;
            codegen.inFunction = this._inFunction;

            let capture = codegen._beginCaptureCode();

            if (isStatement) {
                codegen.generateStatements(content);
            } else {
                codegen.generateCode(content);
            }

            slotCode = capture.end();

            if (isStatement && slotCode.startsWith(codegen.currentIndent)) {
                slotCode = slotCode.substring(codegen.currentIndent.length);
            }
        }



        let oldCode = codegen._code;
        let beforeCode = oldCode.substring(0, this._start);
        let afterCode = oldCode.substring(this._end);

        if (slotCode) {
            codegen._code = beforeCode + slotCode + afterCode;
        } else {
            let beforeWhitespaceMatches = beforeCode.match(/[\n]\s*$/);
            if (beforeWhitespaceMatches != null) {
                let beforeWhitespace = beforeWhitespaceMatches[0];

                if (afterCode.startsWith(beforeWhitespace)) {
                    afterCode = afterCode.substring(beforeWhitespace.length);
                }
            }
            codegen._code = beforeCode + afterCode;
        }
    }
}

class Generator {
    constructor(context, options) {
        options = options || {};
        this.root = null;
        this._indentStr = options.indent != null ? options.indent : '  ';
        this._indentSize = this._indentStr.length;

        this._code = '';
        this.currentIndent = '';
        this.inFunction = false;

        this._doneListeners = [];

        this._bufferedWrites = null;
        this.builder = context.builder;
        this.outputType = options.output || 'html';
        this.context = context;

        ok(this.builder, '"this.builder" is required');

        this._codegenCodeMethodName = 'generate' +
            this.outputType.charAt(0).toUpperCase() +
            this.outputType.substring(1) +
            'Code';

        this._slots = [];
    }

    beginSlot(slotNode) {
        var addSeparator = slotNode.statement;
        this._flushBufferedWrites(addSeparator);
        let slot = new Slot(this, slotNode);
        this._slots.push(slot);
        return slot;
    }

    addVar(name, value) {
        return this.context.addVar(name, value);
    }

    addStaticVar(name, value) {
        return this.context.addStaticVar(name, value);
    }

    addStaticCode(code) {
        this.context.addStaticCode(code);
    }

    getEscapeXmlAttrVar() {
        return this.context.getEscapeXmlAttrVar();
    }

    importModule(varName, path) {
        return this.context.importModule(varName, path);
    }

    generateCode(node) {
        ok(node != null, '"node" is required');

        if (typeof node === 'string' ||
            typeof node === 'number' ||
            typeof node === 'boolean') {
            this.write(node);
            return;
        } else if (isArray(node)) {
            node.forEach(this.generateCode, this);
            return;
        } else if (node instanceof Container) {
            node.forEach((child) => {
                if (child.container === node) {
                    this.generateCode(child);
                }
            });
            return;
        }

        let oldCurrentNode = this._currentNode;
        this._currentNode = node;

        let finalNode;
        let generateCodeFunc;
        var isStatement = node.statement;

        var beforeAfterEvent;

        if (node.listenerCount('beforeGenerateCode') || node.listenerCount('beforeGenerateCode')) {
            beforeAfterEvent = new GeneratorEvent(node, this);
        }

        if (beforeAfterEvent) {
            beforeAfterEvent.isBefore = true;
            beforeAfterEvent.node.emit('beforeGenerateCode', beforeAfterEvent);
        }

        if (node.getCodeGenerator) {
            generateCodeFunc = node.getCodeGenerator(this.outputType);
            if (generateCodeFunc) {
                finalNode = generateCodeFunc(node, this);

                if (finalNode === node) {
                    // If the same node was returned then we will generate
                    // code for the node as normal
                    finalNode = null;
                } else if (finalNode == null) {
                    // If nothing was returned then don't generate any code
                    node = null;
                }
            }
        }

        if (finalNode) {
            if (isStatement) {
                this.generateStatements(finalNode);
            } else {
                this.generateCode(finalNode);
            }
        } else if (node) {
            let generateCodeMethod = node.generateCode;

            if (!generateCodeMethod) {
                generateCodeMethod = node[this._codegenCodeMethodName];

                if (!generateCodeMethod) {
                    throw new Error('No code codegen for node of type "' +
                        node.type +
                        '" (output type: "' + this.outputType + '"). Node: ' + util.inspect(node));
                }
            }

            // The generateCode function can optionally return either of the following:
            // - An AST node
            // - An array/cointainer of AST nodes
            finalNode = generateCodeMethod.call(node, this);

            if (finalNode != null) {
                if (finalNode === node) {
                    throw new Error('Invalid node returned. Same node returned:  ' + util.inspect(node));
                }

                if (isStatement) {
                    this.generateStatements(finalNode);
                } else {
                    this.generateCode(finalNode);
                }
            }
        }

        if (beforeAfterEvent) {
            beforeAfterEvent.isBefore = false;
            beforeAfterEvent.node.emit('afterGenerateCode', beforeAfterEvent);
        }

        this._currentNode = oldCurrentNode;
    }

    getCode() {
        this._flushBufferedWrites();

        while(this._doneListeners.length || this._slots.length) {

            let doneListeners = this._doneListeners;
            if (doneListeners.length) {
                this._doneListeners = [];

                for (let i=0; i<doneListeners.length; i++) {
                    let doneListener = doneListeners[i];
                    doneListener(this);
                }
            }

            let slots = this._slots;

            if (slots.length) {
                this._slots = [];

                for (let i=slots.length-1; i>=0; i--) {
                    let slot = slots[i];
                    slot.generateCode(this);
                }
            }
        }

        return this._code;
    }

    generateBlock(body) {
        if (!body) {
            this.write('{}');
            return;
        }

        if (typeof body === 'function') {
            body = body();
        }

        if (!isArray(body) && !(body instanceof Container)) {
            throw new Error('Invalid body');
        }

        if (body.length === 0) {
            this.write('{}');
            return;
        }

        this.write('{\n')
            .incIndent();

        let oldCodeLength = this._code.length;

        this.generateStatements(body);

        if (this._bufferedWrites) {
            if (this._code.length !== oldCodeLength) {
                this._code += '\n';
            }
            this._flushBufferedWrites();
        }

        this.decIndent()
            .writeLineIndent()
            .write('}');
    }

    generateStatements(nodes) {
        ok(nodes, '"nodes" expected');
        let firstStatement = true;

        if (nodes instanceof Node) {
            nodes = [nodes];
        }

        nodes.forEach((node) => {
            if (node instanceof Node) {
                node.statement = true;
            }

            let startCodeLen = this._code.length;

            let currentIndent = this.currentIndent;

            if (!firstStatement) {
                this._write('\n');
            }

            if (!this._code.endsWith(currentIndent)) {
                this.writeLineIndent();
            }

            let startPos = this._code.length;

            if (Array.isArray(node) || (node instanceof Container)) {
                this.generateStatements(node);
            } else {
                this.generateCode(node);
            }

            if (this._code.length === startPos) {
                // No code was generated. Remove any code that was previously added
                this._code = this._code.slice(0, startCodeLen);
                return;
            }

            if (this._code.endsWith('\n')) {
                // Do nothing
            } else if (this._code.endsWith(';')) {
                this._code += '\n';
            }  else if (this._code.endsWith('\n' + this.currentIndent)) {
                // Do nothing
            } else {
                this._code += ';\n';
            }

            firstStatement = false;
        });
    }

    _beginCaptureCode() {
        let oldCode = this._code;
        this._code = '';

        return {
            codegen: this,
            end() {
                let newCode = this.codegen._code;
                this.codegen._code = oldCode;
                return newCode;
            }
        };
    }

    addWriteLiteral(value) {
        if (!(value instanceof Literal)) {
            value = new Literal({value});
        }

        this.addWrite(value);
    }

    addWrite(output) {
        ok(output, '"output" is required');
        if (output instanceof Literal) {
            let lastWrite = this._bufferedWrites ?
                this._bufferedWrites[this._bufferedWrites.length-1] :
                null;
            if (lastWrite instanceof Literal) {
                lastWrite.value += output.value;
                return;
            }
        } else {
            if (!(output instanceof Node)) {
                throw new Error('Invalid write: ' + JSON.stringify(output, null, 2));
            }
        }

        if (!this._bufferedWrites) {
            this._bufferedWrites = [output];
        } else {
            this._bufferedWrites.push(output);
        }
    }

    _flushBufferedWrites(addSeparator) {
        let bufferedWrites = this._bufferedWrites;

        if (!bufferedWrites) {
            return;
        }

        this._bufferedWrites = null;

        if (!addSeparator && !this._code.endsWith(this.currentIndent)) {
            this.writeLineIndent();
        }

        let len = bufferedWrites.length;

        for (let i=0; i<len; i++) {
            let write = bufferedWrites[i];

            if (i === 0) {
                this._write('out.w(');
            } else {
                this._write(' +\n');
                this.writeLineIndent();
                this._write(this._indentStr);
            }

            this.generateCode(write);
        }

        this._write(');\n');

        if (addSeparator) {
            this._write('\n' + this.currentIndent);
        }
    }

    write(code) {
        if (this._bufferedWrites) {
            this._flushBufferedWrites(true /* add separator */);
        }
        this._code += code;
        return this;
    }

    _write(code) {
        this._code += code;
        return this;
    }

    incIndent(count) {
        this._flushBufferedWrites(true /* add separator */);

        if (count != null) {
            for (let i=0; i<count; i++) {
                this.currentIndent += ' ';
            }
        } else {
            this.currentIndent += this._indentStr;
        }

        return this;
    }

    decIndent(count) {
        if (count == null) {
            count = this._indentSize;
        }

        this.currentIndent = this.currentIndent.substring(
            0,
            this.currentIndent.length - count);

        return this;
    }

    writeLineIndent() {
        this._code += this.currentIndent;
        return this;
    }

    writeIndent() {
        this._code += this._indentStr;
        return this;
    }

    isLiteralNode(node) {
        return node instanceof Literal;
    }

    isIdentifierNode(node) {
        return node instanceof Identifier;
    }

    writeLiteral(value) {
        if (value === null) {
            this.write('null');
        } else if (value === undefined) {
            this.write('undefined');
        } else if (typeof value === 'string') {
            this.write(JSON.stringify(value));
        } else if (value === true) {
            this.write('true');
        } else if (value === false) {
            this.write('false');
        }  else if (isArray(value)) {
            if (value.length === 0) {
                this.write('[]');
                return;
            }

            this.write('[\n');
            this.incIndent();

            for (let i=0; i<value.length; i++) {
                let v = value[i];

                this.writeLineIndent();

                if (v instanceof Node) {
                    this.generateCode(v);
                } else {
                    this.writeLiteral(v);
                }

                if (i < value.length - 1) {
                    this.write(',\n');
                } else {
                    this.write('\n');
                }
            }

            this.decIndent();
            this.writeLineIndent();
            this.write(']');
        } else if (typeof value === 'number') {
            this.write(value.toString());
        } else if (typeof value === 'object') {
            let keys = Object.keys(value);
            if (keys.length === 0) {
                this.write('{}');
                return;
            }

            this.incIndent();
            this.write('{\n');
            this.incIndent();

            for (let i=0; i<keys.length; i++) {
                let k = keys[i];
                let v = value[k];

                this.writeLineIndent();

                if (isValidJavaScriptVarName(k)) {
                    this.write(k + ': ');
                } else {
                    this.write(JSON.stringify(k) + ': ');
                }

                if (v instanceof Node) {
                    this.generateCode(v);
                } else {
                    this.writeLiteral(v);
                }

                if (i < keys.length - 1) {
                    this.write(',\n');
                } else {
                    this.write('\n');
                }
            }

            this.decIndent();
            this.writeLineIndent();
            this.write('}');
            this.decIndent();
        }
    }

    isPreserveWhitespaceEnabled() {
        return false;
    }

    addError(message, code) {
        ok('"message" is required');

        let node = this._currentNode;

        if (typeof message === 'object') {
            let errorInfo = message;
            errorInfo.node = node;
            this.context.addError(errorInfo);
        } else {
            this.context.addError({node, message, code});
        }
    }

    onDone(listenerFunc) {
        this._doneListeners.push(listenerFunc);
    }

    getRequirePath(targetFilename) {
        return this.context.getRequirePath(targetFilename);
    }

    resolvePath(pathExpression) {
        return this.context.resolvePath(pathExpression);
    }
}

module.exports = Generator;
});
$rmod.def("/raptor-util@1.0.10/createError", function(require, exports, module, __filename, __dirname) { module.exports = function(message, cause) {
    var error;
    var argsLen = arguments.length;
    var E = Error;
    
    if (argsLen == 2) {
        error = message instanceof E ? message : new E(message);
        if (error.stack) {
            error.stack += '\nCaused by: ' + (cause.stack || cause);
        } else {
            error._cause = cause;    
        }
    } else if (argsLen == 1) {
        error = message instanceof E ? message : new E(message);
    }
    
    return error;
};
});
$rmod.def("/marko@3.3.0/compiler/Compiler", function(require, exports, module, __filename, __dirname) { 'use strict';
var ok = require('/$/assert'/*'assert'*/).ok;
var CodeGenerator = require('./CodeGenerator');
var CompileContext = require('./CompileContext');
var createError = require('/$/raptor-util/createError'/*'raptor-util/createError'*/);
var config = require('./config');
var extend = require('/$/raptor-util/extend'/*'raptor-util/extend'*/);

const FLAG_TRANSFORMER_APPLIED = 'transformerApply';

function transformNode(node, context) {
    try {
        context.taglibLookup.forEachNodeTransformer(node, function (transformer) {
            if (!node.isTransformerApplied(transformer)) {
                //Check to make sure a transformer of a certain type is only applied once to a node
                node.setTransformerApplied(transformer);
                //Mark the node as have been transformed by the current transformer
                context.setFlag(FLAG_TRANSFORMER_APPLIED);
                //Set the flag to indicate that a node was transformed
                // node.compiler = this;
                var transformerFunc = transformer.getFunc();
                transformerFunc.call(transformer, node, context);    //Have the transformer process the node (NOTE: Just because a node is being processed by the transformer doesn't mean that it has to modify the parse tree)
            }
        });
    } catch (e) {
        throw createError(new Error('Unable to compile template at path "' + context.filename + '". Error: ' + e.message), e);
    }
}

function transformTreeHelper(node, context) {
    transformNode(node, context);

    /*
     * Now process the child nodes by looping over the child nodes
     * and transforming the subtree recursively
     *
     * NOTE: The length of the childNodes array might change as the tree is being performed.
     *       The checks to prevent transformers from being applied multiple times makes
     *       sure that this is not a problem.
     */
    node.forEachChild(function (childNode) {
        if (childNode.isDetached()) {
            return;    //The child node might have been removed from the tree
        }
        transformTreeHelper(childNode, context);
    });
}

function transformTree(rootNode, context) {
    /*
     * The tree is continuously transformed until we go through an entire pass where
     * there were no new nodes that needed to be transformed. This loop makes sure that
     * nodes added by transformers are also transformed.
     */
    do {
        context.clearFlag(FLAG_TRANSFORMER_APPLIED);
        //Reset the flag to indicate that no transforms were yet applied to any of the nodes for this pass
        transformTreeHelper(rootNode, context);    //Run the transforms on the tree
    } while (context.isFlagSet(FLAG_TRANSFORMER_APPLIED));

    return rootNode;
}

class Compiler {
    constructor(options) {
        ok(options, '"options" is required');

        this.builder = options.builder;
        this.parser = options.parser;

        ok(this.builder, '"options.builder" is required');
        ok(this.parser, '"options.parser" is required');
    }

    compile(src, filename, userOptions) {
        ok(typeof src === 'string', '"src" argument should be a string');
        ok(filename, '"filename" argument is required');
        ok(typeof filename === 'string', '"filename" argument should be a string');

        var context = new CompileContext(src, filename, this.builder);
        var options = {};

        extend(options, config);

        if (userOptions) {
            extend(options, userOptions);
        }

        if (options.preserveWhitespace) {
            context.setPreserveWhitespace(true);
        }

        var codeGenerator = new CodeGenerator(context);

        // STAGE 1: Parse the template to produce the initial AST
        var ast = this.parser.parse(src, context);

        // Trim start and end whitespace for the root node
        ast._normalizeChildTextNodes(codeGenerator, true /* trim start and end */, true /* force */);

        context.root = ast;
        // console.log('ROOT', JSON.stringify(ast, null, 2));

        // STAGE 2: Transform the initial AST to produce the final AST
        var transformedAST = transformTree(ast, context);
        // console.log('transformedAST', JSON.stringify(ast, null, 2));

        // Trim start and end whitespace for the root node (again, after the transformation)
        transformedAST._normalizeChildTextNodes(codeGenerator, true /* trim start and end */, true /* force */);

        // STAGE 3: Generate the code using the final AST

        codeGenerator.generateCode(transformedAST);

        // If there were any errors then compilation failed.
        if (context.hasErrors()) {
            var errors = context.getErrors();

            var message = 'An error occurred while trying to compile template at path "' + filename + '". Error(s) in template:\n';
            for (var i = 0, len = errors.length; i < len; i++) {
                let error = errors[i];
                message += (i + 1) + ') ' + error.toString() + '\n';
            }
            var error = new Error(message);
            error.errors = errors;
            throw error;
        }

        // Return the generated code as the compiled output:
        var compiledSrc = codeGenerator.getCode();
        return compiledSrc;
    }
}

module.exports = Compiler;
});
$rmod.def("/marko@3.3.0/compiler/Walker", function(require, exports, module, __filename, __dirname) { 'use strict';
var isArray = Array.isArray;
var Container = require('./ast/Container');

function noop() {}

class Walker {
    constructor(options) {
        this._enter = options.enter || noop;
        this._exit = options.exit || noop;
        this._stopped = false;
        this._reset();
        this._stack = [];
    }

    _reset() {
        this._skipped = false;
        this._replaced = undefined;
        this._removed = false;
    }

    skip() {
        this._skipped = true;
    }

    stop() {
        this._stopped = true;
    }

    replace(newNode) {
        this._replaced = newNode;
    }

    remove() {
        this._removed = true;
    }

    _walkArray(array) {
        var hasRemoval = false;

        array.forEach((node, i) => {
            var transformed = this.walk(node);
            if (transformed == null) {
                array[i] = null;
                hasRemoval = true;
            } else if (transformed !== node) {
                array[i] = transformed;
            }
        });

        if (hasRemoval) {
            for (let i=array.length-1; i>=0; i--) {
                if (array[i] == null) {
                    array.splice(i, 1);
                }
            }
        }

        return array;
    }

    _walkContainer(nodes) {
        nodes.forEach((node) => {
            var transformed = this.walk(node);
            if (!transformed) {
                node.container.removeChild(node);
            } else if (transformed !== node) {
                node.container.replaceChild(transformed, node);
            }
        });
    }

    walk(node) {
        if (!node || this._stopped || typeof node === 'string') {
            return node;
        }

        this._reset();

        var parent = this._stack.length ? this._stack[this._stack.length - 1] : undefined;

        this._stack.push(node);

        var replaced = this._enter(node, parent);
        if (replaced === undefined) {
            replaced = this._replaced;
        }

        if (this._removed) {
            replaced = null;
        }

        if (replaced !== undefined) {
            this._stack.pop();
            return replaced;
        }

        if (this._skipped || this._stopped) {
            this._stack.pop();
            return node;
        }

        if (isArray(node)) {
            let array = node;
            let newArray = this._walkArray(array);
            this._stack.pop();
            return newArray;
        } else if (node instanceof Container) {
            let container = node;
            this._walkContainer(container);
            this._stack.pop();
            return container;
        } else {
            if (node.walk) {
                node.walk(this);
            }
        }

        if (this._stopped) {
            this._stack.pop();
            return node;
        }

        this._reset();

        replaced = this._exit(node, parent);
        if (replaced === undefined) {
            replaced = this._replaced;
        }

        if (this._removed) {
            replaced = null;
        }

        if (replaced !== undefined) {
            this._stack.pop();
            return replaced;
        }

        this._stack.pop();
        return node;
    }
}

module.exports = Walker;


});
$rmod.def("/marko@3.3.0/compiler/ast/AttributePlaceholder", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class AttributePlaceholder extends Node {
    constructor(def) {
        super('AttributePlaceholder');
        this.value = def.value;
        this.escape = def.escape;
    }

    generateCode(codegen) {
        codegen.generateCode(this.value);
    }

    walk(walker) {
        this.value = walker.walk(this.value);
    }

    isCompoundExpression() {
        return this.value.isCompoundExpression();
    }

    /**
     * "noOutput" should be true if the Node.js does not result in any HTML or Text output
     */
    get noOutput() {
        return this.value.noOutput;
    }
}

module.exports = AttributePlaceholder;
});
$rmod.def("/marko@3.3.0/compiler/Parser", function(require, exports, module, __filename, __dirname) { 'use strict';
var ok = require('/$/assert'/*'assert'*/).ok;
var AttributePlaceholder = require('./ast/AttributePlaceholder');

var COMPILER_ATTRIBUTE_HANDLERS = {
    'preserve-whitespace': function(attr, context) {
        context.setPreserveWhitespace(true);
    },
    'preserve-comments': function(attr, context) {
        context.setPreserveComments(true);
    }
};

var ieConditionalCommentRegExp = /^\[if [^]*?<!\[endif\]$/;

function isIEConditionalComment(comment) {
    return ieConditionalCommentRegExp.test(comment);
}

function replacePlaceholderEscapeFuncs(node, context) {
    var walker = context.createWalker({
        exit: function(node, parent) {
            if (node.type === 'FunctionCall' &&
                node.callee.type === 'Identifier') {

                if (node.callee.name === '$noEscapeXml') {
                    return new AttributePlaceholder({escape: false, value: node.args[0]});
                } else if (node.callee.name === '$escapeXml') {
                    return new AttributePlaceholder({escape: true, value: node.args[0]});
                }
            }
        }
    });

    return walker.walk(node);
}

function mergeShorthandClassNames(el, shorthandClassNames, context) {
    var builder = context.builder;
    let classNames = shorthandClassNames.map((className) => {
        return builder.parseExpression(className.value);
    });

    var classAttr = el.getAttributeValue('class');
    if (classAttr) {
        classNames.push(classAttr);
    }

    let prevClassName;

    var finalClassNames = [];

    for (var i=0; i<classNames.length; i++) {
        let className = classNames[i];
        if (prevClassName && className.type === 'Literal' && prevClassName.type === 'Literal') {
            prevClassName.value += ' ' + className.value;
        } else {
            finalClassNames.push(className);
        }
        prevClassName = className;
    }

    if (finalClassNames.length === 1) {
        el.setAttributeValue('class', finalClassNames[0]);
    } else {
        var classListVar = context.addStaticVar('__classList', '__helpers.cl');
        el.setAttributeValue('class', builder.functionCall(classListVar, finalClassNames));
    }
}

class Parser {
    constructor(parserImpl, options) {
        ok(parserImpl, '"parserImpl" is required');

        this.parserImpl = parserImpl;

        this.prevTextNode = null;
        this.stack = null;

        this.raw = options && options.raw === true;

        // The context gets provided when parse is called
        // but we store it as part of the object so that the handler
        // methods have access
        this.context = null;
    }

    _reset() {
        this.prevTextNode = null;
        this.stack = [];
    }

    parse(src, context) {
        ok(typeof src === 'string', '"src" should be a string');
        ok(context, '"context" is required');

        this._reset();

        this.context = context;

        var builder = context.builder;
        var rootNode = builder.templateRoot();

        this.stack.push({
            node: rootNode
        });

        this.parserImpl.parse(src, this);

        return rootNode;
    }

    handleCharacters(text) {
        var builder = this.context.builder;

        if (this.prevTextNode && this.prevTextNode.isLiteral()) {
            this.prevTextNode.appendText(text);
        } else {
            var escape = false;
            this.prevTextNode = builder.text(builder.literal(text), escape);
            this.parentNode.appendChild(this.prevTextNode);
        }
    }

    handleStartElement(el) {
        var context = this.context;
        var builder = context.builder;

        var tagName = el.tagName;
        var tagNameExpression = el.tagNameExpression;
        var attributes = el.attributes;
        var argument = el.argument; // e.g. For <for(color in colors)>, argument will be "color in colors"

        if (argument) {
            argument = argument.value;
        }

        var raw = this.raw;

        if (!raw) {
            if (tagNameExpression) {
                tagName = builder.parseExpression(tagNameExpression);
            } else if (tagName === 'marko-compiler-options') {
                attributes.forEach(function (attr) {
                    let attrName = attr.name;
                    let handler = COMPILER_ATTRIBUTE_HANDLERS[attrName];

                    if (!handler) {
                        context.addError({
                            code: 'ERR_INVALID_COMPILER_OPTION',
                            message: 'Invalid Marko compiler option of "' + attrName + '". Allowed: ' + Object.keys(COMPILER_ATTRIBUTE_HANDLERS).join(', '),
                            pos: el.pos,
                            node: el
                        });
                        return;
                    }

                    handler(attr, context);
                });

                return;
            }
        }

        this.prevTextNode = null;

        var attributeParseErrors = [];

        var elDef = {
            tagName: tagName,
            argument: argument,
            openTagOnly: el.openTagOnly === true,
            selfClosed: el.selfClosed === true,
            pos: el.pos,
            attributes: attributes.map((attr) => {
                var attrValue;
                if (attr.hasOwnProperty('literalValue')) {
                    attrValue = builder.literal(attr.literalValue);
                } else if (attr.value == null) {
                    attrValue = undefined;
                } else {
                    let parsedExpression;
                    let valid = true;
                    try {
                        parsedExpression = builder.parseExpression(attr.value);
                    } catch(e) {
                        valid = false;
                        attributeParseErrors.push('Invalid JavaScript expression for attribute "' + attr.name + '": ' + e);
                    }

                    if (valid) {
                        if (raw) {
                            attrValue = parsedExpression;
                        } else {
                            attrValue = replacePlaceholderEscapeFuncs(parsedExpression, context);
                        }
                    } else {
                        attrValue = null;
                    }
                }

                var attrDef = {
                    name: attr.name,
                    value: attrValue,
                    rawValue: attr.value
                };

                if (attr.argument) {
                    // TODO Do something with the argument pos
                    attrDef.argument = attr.argument.value;
                }

                return attrDef;
            })
        };

        var node;

        if (raw) {

            node = builder.htmlElement(elDef);
            node.pos = elDef.pos;

            let taglibLookup = this.context.taglibLookup;
            let tagDef = taglibLookup.getTag(tagName);
            node.tagDef = tagDef;
        } else {
            node = this.context.createNodeForEl(elDef);
        }

        if (attributeParseErrors.length) {

            attributeParseErrors.forEach((e) => {
                context.addError(node, e);
            });
        }

        if (raw) {
            if (el.shorthandId) {
                let parsed = builder.parseExpression(el.shorthandId.value);
                node.rawShorthandId = parsed.value;
            }

            if (el.shorthandClassNames) {
                node.rawShorthandClassNames = el.shorthandClassNames.map((className) => {
                    let parsed = builder.parseExpression(className.value);
                    return parsed.value;
                });
            }
        } else {
            if (el.shorthandClassNames) {
                mergeShorthandClassNames(node, el.shorthandClassNames, context);
            }

            if (el.shorthandId) {
                if (node.hasAttribute('id')) {
                    context.addError(node, 'A shorthand ID cannot be used in conjunction with the "id" attribute');
                } else {
                    node.setAttributeValue('id', builder.parseExpression(el.shorthandId.value));
                }
            }
        }

        this.parentNode.appendChild(node);

        this.stack.push({
            node: node,
            tag: null
        });
    }

    handleEndElement(elementName) {
        if (this.raw !== true) {
            if (elementName === 'marko-compiler-options') {
                return;
            }
        }

        this.prevTextNode = null;

        this.stack.pop();
    }

    handleComment(comment) {
        this.prevTextNode = null;

        var builder = this.context.builder;

        var preserveComment = this.context.isPreserveComments() ||
            isIEConditionalComment(comment);

        if (this.raw || preserveComment) {
            var commentNode = builder.htmlComment(builder.literal(comment));
            this.parentNode.appendChild(commentNode);
        }
    }

    handleDeclaration(value) {
        this.prevTextNode = null;

        var builder = this.context.builder;

        var declarationNode = builder.declaration(builder.literal(value));
        this.parentNode.appendChild(declarationNode);
    }

    handleDocumentType(value) {
        this.prevTextNode = null;

        var builder = this.context.builder;

        var docTypeNode = builder.documentType(builder.literal(value));
        this.parentNode.appendChild(docTypeNode);
    }

    handleBodyTextPlaceholder(expression, escape) {
        this.prevTextNode = null;
        var builder = this.context.builder;
        var parsedExpression = builder.parseExpression(expression);
        var preserveWhitespace = true;

        var text = builder.text(parsedExpression, escape, preserveWhitespace);
        this.parentNode.appendChild(text);
    }

    handleScriptlet(code) {
        this.prevTextNode = null;
        var builder = this.context.builder;
        var scriptlet = builder.scriptlet(code);
        this.parentNode.appendChild(scriptlet);
    }

    handleError(event) {
        this.context.addError({
            message: event.message,
            code: event.code,
            pos: event.pos,
            endPos: event.endPos
        });
    }

    get parentNode() {
        var last = this.stack[this.stack.length-1];
        return last.node;
    }

    getParserStateForTag(el) {
        var attributes = el.attributes;

        for (var i=0; i<attributes.length; i++) {
            var attr = attributes[i];
            var attrName = attr.name;
            if (attrName === 'marko-body') {
                var parseMode;

                if (attr.literalValue) {
                    parseMode = attr.literalValue;
                }

                if (parseMode === 'static-text' ||
                    parseMode === 'parsed-text' ||
                    parseMode === 'html') {
                    return parseMode;
                } else {
                    this.context.addError({
                        message: 'Value for "marko-body" should be one of the following: "static-text", "parsed-text", "html"',
                        code: 'ERR_INVALID_ATTR'
                    });
                    return;
                }
            } else if (attrName === 'marko-init') {
                return 'static-text';
            }
        }

        var tagName = el.tagName;
        var tagDef = this.context.getTagDef(tagName);

        if (tagDef) {
            var body = tagDef.body;
            if (body) {
                return body; // 'parsed-text' | 'static-text' | 'html'
            }
        }

        return null; // Default parse state
    }

    isOpenTagOnly(tagName) {
        var tagDef = this.context.getTagDef(tagName);
        return tagDef && tagDef.openTagOnly;
    }
}

module.exports = Parser;
});
$rmod.main("/htmljs-parser@1.5.13", "index");
$rmod.dep("", "htmljs-parser", "1.5.13");
$rmod.def("/htmljs-parser@1.5.13/BaseParser", function(require, exports, module, __filename, __dirname) { 'use strict';

var CODE_NEWLINE = 10;
var CODE_CARRIAGE_RETURN = 13;

class Parser {
    static createState(mixins) {
        return mixins;
    }

    constructor(options) {
        this.reset();
    }

    reset() {
        // current absolute character position
        this.pos = -1;

        // The maxPos property is the last absolute character position that is
        // readable based on the currently received chunks
        this.maxPos = -1;

        // the current parser state
        this.state = null;

        // The raw string that we are parsing
        this.data = null;
    }

    setInitialState(initialState) {
        this.initialState = initialState;
    }

    enterState(state) {
        if (this.state === state) {
            // Re-entering the same state can lead to unexpected behavior
            // so we should throw error to catch these types of mistakes
            throw new Error('Re-entering the current state is illegal - ' + state.name);
        }

        var oldState;
        if ((oldState = this.state) && oldState.leave) {
            // console.log('Leaving state ' + oldState.name);
            oldState.leave.call(this, state);
        }

        // console.log('Entering state ' + state.name);

        this.state = state;

        if (state.enter) {
            state.enter.call(this, oldState);
        }
    }

    /**
     * Look ahead to see if the given str matches the substring sequence
     * beyond
     */
    lookAheadFor(str, startPos) {
        // Have we read enough chunks to read the string that we need?
        if (startPos == null) {
            startPos = this.pos + 1;
        }
        var len = str.length;
        var endPos = startPos + len;

        if (endPos > this.maxPos + 1) {
            return undefined;
        }

        var found = this.data.substring(startPos, endPos);
        return (found === str) ? str : undefined;
    }

    /**
     * Look ahead to a character at a specific offset.
     * The callback will be invoked with the character
     * at the given position.
     */
    lookAtCharAhead(offset, startPos) {
        if (startPos == null) {
            startPos = this.pos;
        }
        return this.data.charAt(startPos + offset);
    }

    lookAtCharCodeAhead(offset, startPos) {
        if (startPos == null) {
            startPos = this.pos;
        }
        return this.data.charCodeAt(startPos + offset);
    }

    rewind(offset) {
        this.pos -= offset;
    }

    skip(offset) {
        // console.log('-- ' + JSON.stringify(this.data.substring(this.pos, this.pos + offset)) + ' --  ' + 'SKIPPED'.gray);
        this.pos += offset;
    }

    end() {
        this.pos = this.maxPos + 1;
    }

    substring(pos, endPos) {
        return this.data.substring(pos, endPos);
    }

    parse(data) {
        if (data == null) {
            return;
        }

        // call the constructor function again because we have a contract that
        // it will fully reset the parser
        this.reset();

        if (Array.isArray(data)) {
            data = data.join('');
        }

        // Strip off the byte order mark (BOM) sequence
        // at the beginning of the file:
        // - https://en.wikipedia.org/wiki/Byte_order_mark
        // > The Unicode Standard permits the BOM in UTF-8, but does not require or recommend its use.
        if (data.charCodeAt(0) === 0xFEFF) {
    		data = data.slice(1);
    	}

        this.data = data;
        this.maxPos = data.length - 1;

        // Enter initial state
        if (this.initialState) {
            this.enterState(this.initialState);
        }

        // Move to first position
        this.pos = 0;

        if (!this.state) {
            // Cannot resume when parser has no state
            return;
        }

        var pos;
        while ((pos = this.pos) <= this.maxPos) {
            let ch = data[pos];
            let code = ch.charCodeAt(0);
            let state = this.state;

            if (code === CODE_NEWLINE) {
                if (state.eol) {
                    state.eol.call(this, ch);
                }
                this.pos++;
                continue;
            } else if (code === CODE_CARRIAGE_RETURN) {
                let nextPos = pos + 1;
                if (nextPos < data.length && data.charCodeAt(nextPos) === CODE_NEWLINE) {
                    if (state.eol) {
                        state.eol.call(this, '\r\n');
                    }
                    this.pos+=2;
                    continue;
                }
            }

            // console.log('-- ' + JSON.stringify(ch) + ' --  ' + this.state.name.gray);

            // We assume that every state will have "char" function
            state.char.call(this, ch, code);

            // move to next position
            this.pos++;
        }

        let state = this.state;
        if (state && state.eof) {
            state.eof.call(this);
        }
    }
}

module.exports = Parser;

});
$rmod.def("/htmljs-parser@1.5.13/notify-util", function(require, exports, module, __filename, __dirname) { exports.createNotifiers = function(parser, listeners) {
    var hasError = false;

    return {
        notifyText(value) {
            if (hasError) {
                return;
            }

            var eventFunc = listeners.onText;

            if (eventFunc && (value.length > 0)) {
                eventFunc.call(parser, {
                    type: 'text',
                    value: value
                }, parser);
            }
        },

        notifyCDATA(value, pos, endPos) {
            if (hasError) {
                return;
            }

            var eventFunc = listeners.onCDATA;

            if (eventFunc && value) {
                eventFunc.call(parser, {
                    type: 'cdata',
                    value: value,
                    pos: pos,
                    endPos: endPos
                }, parser);
            }
        },

        notifyError(pos, errorCode, message) {
            if (hasError) {
                return;
            }

            hasError = true;

            var eventFunc = listeners.onError;

            if (eventFunc) {
                eventFunc.call(parser, {
                    type: 'error',
                    code: errorCode,
                    message: message,
                    pos: pos,
                    endPos: parser.pos
                }, parser);
            }
        },

        notifyOpenTag(tagInfo) {
            if (hasError) {
                return;
            }

            var eventFunc = listeners.onOpenTag;

            if (eventFunc) {
                // set the literalValue property for attributes that are simple
                // string simple values or simple literal values

                var event = {
                    type: 'openTag',
                    tagName: tagInfo.tagName,
                    tagNameExpression: tagInfo.tagNameExpression,
                    argument: tagInfo.argument,
                    pos: tagInfo.pos,
                    endPos: tagInfo.endPos,
                    openTagOnly: tagInfo.openTagOnly,
                    selfClosed: tagInfo.selfClosed,
                    concise: tagInfo.concise
                };

                if (tagInfo.shorthandId) {
                    event.shorthandId = tagInfo.shorthandId;
                }

                if (tagInfo.shorthandClassNames) {
                    event.shorthandClassNames = tagInfo.shorthandClassNames;
                }

                event.attributes = tagInfo.attributes.map((attr) => {
                    var newAttr = {
                        name: attr.name,
                        value: attr.value,
                        pos: attr.pos,
                        endPos: attr.endPos,
                        argument: attr.argument
                    };

                    if (attr.hasOwnProperty('literalValue')) {
                        newAttr.literalValue = attr.literalValue;
                    }

                    return newAttr;
                });

                eventFunc.call(parser, event, parser);
            }
        },

        notifyCloseTag(tagName, pos, endPos) {
            if (hasError) {
                return;
            }

            var eventFunc = listeners.onCloseTag;

            if (eventFunc) {
                var event = {
                    type: 'closeTag',
                    tagName: tagName,
                    pos: pos,
                    endPos: endPos
                };

                eventFunc.call(parser, event, parser);
            }
        },

        notifyDocumentType(documentType) {
            if (hasError) {
                return;
            }

            var eventFunc = listeners.onDocumentType;

            if (eventFunc) {
                eventFunc.call(this, {
                    type: 'documentType',
                    value: documentType.value,
                    pos: documentType.pos,
                    endPos: documentType.endPos
                }, parser);
            }
        },

        notifyDeclaration(declaration) {
            if (hasError) {
                return;
            }

            var eventFunc = listeners.onDeclaration;

            if (eventFunc) {
                eventFunc.call(parser, {
                    type: 'declaration',
                    value: declaration.value,
                    pos: declaration.pos,
                    endPos: declaration.endPos
                }, parser);
            }
        },

        notifyComment(comment) {
            if (hasError) {
                return;
            }

            var eventFunc = listeners.onComment;

            if (eventFunc && comment.value) {
                eventFunc.call(parser, {
                    type: 'comment',
                    value: comment.value,
                    pos: comment.pos,
                    endPos: comment.endPos
                }, parser);
            }
        },

        notifyScriptlet(scriptlet) {
            if (hasError) {
                return;
            }

            var eventFunc = listeners.onScriptlet;

            if (eventFunc && scriptlet.value) {
                eventFunc.call(parser, {
                    type: 'scriptlet',
                    value: scriptlet.value,
                    pos: scriptlet.pos,
                    endPos: scriptlet.endPos
                }, parser);
            }
        },

        notifyPlaceholder(placeholder) {
            if (hasError) {
                return;
            }

            var eventFunc = listeners.onPlaceholder;
            if (eventFunc) {
                var placeholderEvent = {
                    type: 'placeholder',
                    value: placeholder.value,
                    pos: placeholder.pos,
                    endPos: placeholder.endPos,
                    escape: placeholder.escape !== false,
                    withinBody: placeholder.withinBody === true,
                    withinAttribute: placeholder.withinAttribute === true,
                    withinString: placeholder.withinString === true,
                    withinOpenTag: placeholder.withinOpenTag === true,
                    withinTagName: placeholder.withinTagName === true
                };

                eventFunc.call(parser, placeholderEvent, parser);
                return placeholderEvent.value;
            }

            return placeholder.value;
        },

        notifyFinish() {
            if (listeners.onfinish) {
                listeners.onfinish.call(parser, {}, parser);
            }
        }
    };
};
});
$rmod.def("/htmljs-parser@1.5.13/html-tags", function(require, exports, module, __filename, __dirname) { var openTagOnly = {};

[
    'base',
    'br',
    'col',
    'hr',
    'embed',
    'img',
    'input',
    'keygen',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr'
].forEach(function(tagName) {
    openTagOnly[tagName] = true;
});

// [
//     'a',
//     'abbr',
//     'address',
//     'area',
//     'article',
//     'aside',
//     'audio',
//     'b',
//     'bdi',
//     'bdo',
//     'blockquote',
//     'body',
//     'button',
//     'canvas',
//     'caption',
//     'cite',
//     'code',
//     'colgroup',
//     'command',
//     'datalist',
//     'dd',
//     'del',
//     'details',
//     'dfn',
//     'div',
//     'dl',
//     'dt',
//     'em',
//     'fieldset',
//     'figcaption',
//     'figure',
//     'footer',
//     'form',
//     'h1',
//     'h2',
//     'h3',
//     'h4',
//     'h5',
//     'h6',
//     'head',
//     'header',
//     'hgroup',
//     'html',
//     'i',
//     'iframe',
//     'ins',
//     'kbd',
//     'label',
//     'legend',
//     'li',
//     'map',
//     'mark',
//     'menu',
//     'meter',
//     'nav',
//     'noscript',
//     'object',
//     'ol',
//     'optgroup',
//     'option',
//     'output',
//     'p',
//     'pre',
//     'progress',
//     'q',
//     'rp',
//     'rt',
//     'ruby',
//     's',
//     'samp',
//     'script',
//     'section',
//     'select',
//     'small',
//     'span',
//     'strong',
//     'style',
//     'sub',
//     'summary',
//     'sup',
//     'table',
//     'tbody',
//     'td',
//     'textarea',
//     'tfoot',
//     'th',
//     'thead',
//     'time',
//     'title',
//     'tr',
//     'u',
//     'ul',
//     'var',
//     'video',
//     'wbr'
// ].forEach(function(tagName) {
//     openTagOnly[tagName] = {
//         requireClosingTag: true
//     };
// });

exports.isOpenTagOnly = function(tagName) {
    return openTagOnly.hasOwnProperty(tagName);
};
});
$rmod.def("/htmljs-parser@1.5.13/Parser", function(require, exports, module, __filename, __dirname) { 'use strict';
var BaseParser = require('./BaseParser');

var notifyUtil = require('./notify-util');

function isWhitespaceCode(code) {
    // For all practical purposes, the space character (32) and all the
    // control characters below it are whitespace. We simplify this
    // condition for performance reasons.
    // NOTE: This might be slightly non-conforming.
    return (code <= 32);
}

var NUMBER_REGEX = /^[\-\+]?\d*(?:\.\d+)?(?:e[\-\+]?\d+)?$/;

/**
 * Takes a string expression such as `"foo"` or `'foo "bar"'`
 * and returns the literal String value.
 */
function evaluateStringExpression(expression, pos, notifyError) {
    // We could just use eval(expression) to get the literal String value,
    // but there is a small chance we could be introducing a security threat
    // by accidently running malicous code. Instead, we will use
    // JSON.parse(expression). JSON.parse() only allows strings
    // that use double quotes so we have to do extra processing if
    // we detect that the String uses single quotes

    if (expression.charAt(0) === "'") {
        expression = expression.substring(1, expression.length - 1);

        // Make sure there are no unescaped double quotes in the string expression...
        expression = expression.replace(/\\\\|\\["]|["]/g, function(match) {
            if (match === '"'){
                // Return an escaped double quote if we encounter an
                // unescaped double quote
                return '\\"';
            } else {
                // Return the escape sequence
                return match;
            }
        });

        expression = '"' + expression + '"';
    }

    try {
        return JSON.parse(expression);
    } catch(e) {
        notifyError(pos,
            'INVALID_STRING',
            'Invalid string (' + expression + '): ' + e);
    }
}


function peek(array) {
    var len = array.length;
    if (!len) {
        return undefined;
    }
    return array[len - 1];
}

const MODE_HTML = 1;
const MODE_CONCISE = 2;

const CODE_NEWLINE = 10;
const CODE_CARRIAGE_RETURN = 13;
const CODE_BACK_SLASH = 92;
const CODE_FORWARD_SLASH = 47;
const CODE_OPEN_ANGLE_BRACKET = 60;
const CODE_CLOSE_ANGLE_BRACKET = 62;
const CODE_EXCLAMATION = 33;
const CODE_QUESTION = 63;
const CODE_OPEN_SQUARE_BRACKET = 91;
const CODE_CLOSE_SQUARE_BRACKET = 93;
const CODE_EQUAL = 61;
const CODE_SINGLE_QUOTE = 39;
const CODE_DOUBLE_QUOTE = 34;
const CODE_BACKTICK = 96;
const CODE_OPEN_PAREN = 40;
const CODE_CLOSE_PAREN = 41;
const CODE_OPEN_CURLY_BRACE = 123;
const CODE_CLOSE_CURLY_BRACE = 125;
const CODE_ASTERISK = 42;
const CODE_HYPHEN = 45;
const CODE_HTML_BLOCK_DELIMITER = CODE_HYPHEN;
const CODE_DOLLAR = 36;
const CODE_SPACE = 32;
const CODE_PERCENT = 37;
const CODE_PERIOD = 46;
const CODE_NUMBER_SIGN = 35;

const BODY_PARSED_TEXT = 1; // Body of a tag is treated as text, but placeholders will be parsed
const BODY_STATIC_TEXT = 2;// Body of a tag is treated as text and placeholders will *not* be parsed

const EMPTY_ATTRIBUTES = [];
const htmlTags = require('./html-tags');

class Parser extends BaseParser {
    constructor(listeners, options) {
        super(options);

        var parser = this;

        var notifiers = notifyUtil.createNotifiers(parser, listeners);
        this.notifiers = notifiers;

        var defaultMode = options && options.concise === false ? MODE_HTML : MODE_CONCISE;
        var userIsOpenTagOnly = options && options.isOpenTagOnly;
        var ignorePlaceholders = options && options.ignorePlaceholders;

        var currentOpenTag; // Used to reference the current open tag that is being parsed
        var currentAttribute; // Used to reference the current attribute that is being parsed
        var closeTagName; // Used to keep track of the current close tag name as it is being parsed
        var closeTagPos; // Used to keep track of the position of the current closing tag
        var expectedCloseTagName; // Used to figure out when a text block has been ended (HTML tags are ignored)
        var text; // Used to buffer text that is found within the body of a tag
        var withinOpenTag;// Set to true if the parser is within the open tag
        var blockStack; // Used to keep track of HTML tags and HTML blocks
        var partStack; // Used to keep track of parts such as CDATA, expressions, declarations, etc.
        var currentPart; // The current part at the top of the part stack
        var indent; // Used to build the indent for the current concise line
        var isConcise; // Set to true if parser is currently in concise mode
        var isWithinSingleLineHtmlBlock; // Set to true if the current block is for a single line HTML block
        var htmlBlockDelimiter; // Current delimiter for multiline HTML blocks nested within a concise tag. e.g. "--"
        var htmlBlockIndent; // Used to hold the indentation for a delimited, multiline HTML block
        var beginMixedMode; // Used as a flag to mark that the next HTML block should enter the parser into HTML mode
        var endingMixedModeAtEOL; // Used as a flag to record that the next EOL to exit HTML mode and go back to concise
        var placeholderDepth; // Used as an easy way to know if an exptression is within a placeholder

        this.reset = function() {
            BaseParser.prototype.reset.call(this);
            text = '';
            currentOpenTag = undefined;
            currentAttribute = undefined;
            closeTagName = undefined;
            closeTagPos = undefined;
            expectedCloseTagName = undefined;
            withinOpenTag = false;
            blockStack = [];
            partStack = [];
            currentPart = undefined;
            indent = '';
            isConcise = defaultMode === MODE_CONCISE;
            isWithinSingleLineHtmlBlock = false;
            htmlBlockDelimiter = null;
            htmlBlockIndent = null;
            beginMixedMode = false;
            endingMixedModeAtEOL = false;
            placeholderDepth = 0;
        };

        this.reset();

        /**
         * This function is called to determine if a tag is an "open only tag". Open only tags such as <img>
         * are immediately closed.
         * @param  {String}  tagName The name of the tag (e.g. "img")
         */
        function isOpenTagOnly(tagName) {
            tagName = tagName.toLowerCase();

            var openTagOnly = userIsOpenTagOnly && userIsOpenTagOnly(tagName);
            if (openTagOnly == null) {
                openTagOnly = htmlTags.isOpenTagOnly(tagName);
            }

            return openTagOnly;
        }

        /**
         * Clear out any buffered body text and notify any listeners
         */
        function endText(txt) {
            if (arguments.length === 0) {
                txt = text;
            }

            notifiers.notifyText(txt);

            // always clear text buffer...
            text =  '';
        }


        function openTagEOL() {
            if (isConcise && !currentOpenTag.withinAttrGroup) {
                // In concise mode we always end the open tag
                finishOpenTag();
            }
        }

        /**
         * This function is used to enter into "HTML" parsing mode instead
         * of concise HTML. We push a block on to the stack so that we know when
         * return back to the previous parsing mode and to ensure that all
         * tags within a block are properly closed.
         */
        function beginHtmlBlock(delimiter) {
            htmlBlockIndent = indent;
            htmlBlockDelimiter = delimiter;

            var parent = peek(blockStack);
            blockStack.push({
                type: 'html',
                delimiter: delimiter,
                indent: indent
            });

            if (parent && parent.body) {
                if (parent.body === BODY_PARSED_TEXT) {
                    parser.enterState(STATE_PARSED_TEXT_CONTENT);
                } else if (parent.body === BODY_STATIC_TEXT) {
                    parser.enterState(STATE_STATIC_TEXT_CONTENT);
                } else {
                    throw new Error('Illegal value for parent.body: ' + parent.body);
                }
            } else {
                return parser.enterState(STATE_HTML_CONTENT);
            }
        }

        /**
         * This method gets called when we are in non-concise mode
         * and we are exiting out of non-concise mode.
         */
        function endHtmlBlock() {
            // End any text
            endText();

            // Make sure all tags in this HTML block are closed
            for (let i=blockStack.length-1; i>=0; i--) {
                var curBlock = blockStack[i];
                if (curBlock.type === 'html') {
                    // Remove the HTML block from the stack since it has ended
                    blockStack.pop();
                    // We have reached the point where the HTML block started
                    // so we can stop
                    break;
                } else {
                    // The current block is for an HTML tag and it still open. When a tag is tag is closed
                    // it is removed from the stack
                    notifyError(curBlock.pos,
                        'MISSING_END_TAG',
                        'Missing ending "' + curBlock.tagName + '" tag');
                    return;
                }
            }

            // Resert variables associated with parsing an HTML block
            htmlBlockIndent = null;
            htmlBlockDelimiter = null;
            isWithinSingleLineHtmlBlock = false;

            if (parser.state !== STATE_CONCISE_HTML_CONTENT) {
                parser.enterState(STATE_CONCISE_HTML_CONTENT);
            }
        }

        /**
         * This function gets called when we reach EOF outside of a tag.
         */
        function htmlEOF() {
            endText();

            while(blockStack.length) {
                var curBlock = peek(blockStack);
                if (curBlock.type === 'tag') {
                    if (curBlock.concise) {
                        closeTag(curBlock.expectedCloseTagName);
                    } else {
                        // We found an unclosed tag on the stack that is not for a concise tag. That means
                        // there is a problem with the template because all open tags should have a closing
                        // tag
                        //
                        // NOTE: We have already closed tags that are open tag only or self-closed
                        notifyError(curBlock.pos,
                            'MISSING_END_TAG',
                            'Missing ending "' + curBlock.tagName + '" tag');
                        return;
                    }
                } else if (curBlock.type === 'html') {
                    if (curBlock.delimiter) {
                        // We reached the end of the file and there is still a delimited HTML block on the stack.
                        // That means we never found the ending delimiter and should emit a parse error
                        notifyError(curBlock.pos,
                            'MISSING_END_DELIMITER',
                            'End of file reached before finding the ending "' + curBlock.delimiter + '" delimiter');
                        return;
                    } else {
                        // We reached the end of file while still within a single line HTML block. That's okay
                        // though since we know the line is completely. We'll continue ending all open concise tags.
                        blockStack.pop();
                    }
                } else {
                    // There is a bug in our parser...
                    throw new Error('Illegal state. There should not be any non-concise tags on the stack when in concise mode');
                }
            }
        }

        function openTagEOF() {
            if (isConcise) {
                if (currentOpenTag.withinAttrGroup) {
                    notifyError(currentOpenTag.pos,
                        'MALFORMED_OPEN_TAG',
                        'EOF reached while within an attribute group (e.g. "[ ... ]").');
                    return;
                }

                // If we reach EOF inside an open tag when in concise-mode
                // then we just end the tag and all other open tags on the stack
                finishOpenTag();
                htmlEOF();
            } else {
                // Otherwise, in non-concise mode we consider this malformed input
                // since the end '>' was not found.
                notifyError(currentOpenTag.pos,
                    'MALFORMED_OPEN_TAG',
                    'EOF reached while parsing open tag');
            }
        }

        var notifyCDATA = notifiers.notifyCDATA;
        var notifyComment = notifiers.notifyComment;
        var notifyOpenTag = notifiers.notifyOpenTag;
        var notifyCloseTag = notifiers.notifyCloseTag;
        var notifyDocumentType = notifiers.notifyDocumentType;
        var notifyDeclaration = notifiers.notifyDeclaration;
        var notifyPlaceholder = notifiers.notifyPlaceholder;
        var notifyScriptlet = notifiers.notifyScriptlet;

        function notifyError(pos, errorCode, message) {
            parser.end();
            notifiers.notifyError(pos, errorCode, message);
        }

        function beginAttribute() {
            currentAttribute = {};
            if (currentOpenTag.attributes === EMPTY_ATTRIBUTES) {
                currentOpenTag.attributes = [currentAttribute];
            } else {
                currentOpenTag.attributes.push(currentAttribute);
            }
            parser.enterState(STATE_ATTRIBUTE_NAME);
            return currentAttribute;
        }

        function endAttribute() {
            currentAttribute = null;
            if (parser.state !== STATE_WITHIN_OPEN_TAG) {
                parser.enterState(STATE_WITHIN_OPEN_TAG);
            }
        }

        function beginOpenTag() {
            endText();

            var tagInfo = {
                type: 'tag',
                tagName: '',
                tagNameParts: null,
                attributes: [],
                argument: undefined,
                pos: parser.pos,
                indent: indent,
                nestedIndent: null, // This will get set when we know what hte nested indent is
                concise: isConcise
            };

            withinOpenTag = true;

            if (beginMixedMode) {
                tagInfo.beginMixedMode = true;
                beginMixedMode = false;
            }

            blockStack.push(tagInfo);

            currentOpenTag = tagInfo;

            parser.enterState(STATE_TAG_NAME);

            return currentOpenTag;
        }

        function finishOpenTag(selfClosed) {
            var tagName = currentOpenTag.tagName;

            currentOpenTag.expectedCloseTagName = expectedCloseTagName =
                parser.substring(currentOpenTag.tagNameStart, currentOpenTag.tagNameEnd);

            var openTagOnly = currentOpenTag.openTagOnly = isOpenTagOnly(tagName);
            var endPos = parser.pos;

            if (!isConcise) {
                if (selfClosed) {
                    endPos += 2; // Skip past '/>'
                } else {
                    endPos += 1;
                }
            }

            if (currentOpenTag.tagNameParts) {
                currentOpenTag.tagNameExpression = currentOpenTag.tagNameParts.join('+');
            }

            currentOpenTag.endPos = endPos;
            currentOpenTag.selfClosed = selfClosed === true;

            if (!currentOpenTag.tagName) {
                tagName = currentOpenTag.tagName = 'div';
            }

            var origState = parser.state;
            notifyOpenTag(currentOpenTag);

            var shouldClose = false;

            if (selfClosed) {
                shouldClose = true;
            } else if (openTagOnly) {
                if (!isConcise) {
                    // Only close the tag if we are not in concise mode. In concise mode
                    // we want to keep the tag on the stack to make sure nothing is nested below it
                    shouldClose = true;
                }
            }

            if (shouldClose) {
                closeTag(expectedCloseTagName);
            }

            withinOpenTag = false;

            if (shouldClose) {
                if (isConcise) {
                    parser.enterConciseHtmlContentState();
                } else {
                    parser.enterHtmlContentState();
                }
            } else {
                // Did the parser stay in the same state after
                // notifying listeners about openTag?
                if (parser.state === origState) {
                    // The listener didn't transition the parser to a new state
                    // so we use some simple rules to find the appropriate state.
                    if (tagName === 'script') {
                        parser.enterJsContentState();
                    } else if (tagName === 'style') {
                        parser.enterCssContentState();
                    } else {
                        if (isConcise) {
                            parser.enterConciseHtmlContentState();
                        } else {
                            parser.enterHtmlContentState();
                        }

                    }
                }
            }

            // We need to record the "expected close tag name" if we transition into
            // either STATE_STATIC_TEXT_CONTENT or STATE_PARSED_TEXT_CONTENT
            currentOpenTag = undefined;
        }

        function closeTag(tagName, pos, endPos) {
            if (!tagName) {
                throw new Error('Illegal state. Invalid tag name');
            }
            var lastTag = blockStack.length ? blockStack.pop() : undefined;

            if (pos == null && closeTagPos != null) {
                pos = closeTagPos;
                endPos = parser.pos + 1;
            }

            if (!lastTag || lastTag.type !== 'tag') {
                return notifyError(pos,
                    'EXTRA_CLOSING_TAG',
                    'The closing "' + tagName + '" tag was not expected');
            }

            if (!lastTag || (lastTag.expectedCloseTagName !== tagName && lastTag.tagName !== tagName)) {
                return notifyError(pos,
                    'MISMATCHED_CLOSING_TAG',
                    'The closing "' + tagName + '" tag does not match the corresponding opening "' + lastTag.expectedCloseTagName + '" tag');
            }

            tagName = lastTag.tagName;

            notifyCloseTag(tagName, pos, endPos);

            if (lastTag.beginMixedMode) {
                endingMixedModeAtEOL = true;
            }

            closeTagName = null;
            closeTagPos = null;

            lastTag = peek(blockStack);
            expectedCloseTagName = lastTag && lastTag.expectedCloseTagName;
        }

        function beginPart() {
            currentPart = {
                pos: parser.pos,
                parentState: parser.state
            };

            partStack.push(currentPart);

            return currentPart;
        }

        function endPart() {
            var last = partStack.pop();
            parser.endPos = parser.pos;
            parser.enterState(last.parentState);
            currentPart = partStack.length ? peek(partStack) : undefined;
            return last;
        }

        // Expression

        function beginExpression(endAfterGroup) {
            var expression = beginPart();
            expression.value = '';
            expression.groupStack = [];
            expression.endAfterGroup = endAfterGroup === true;
            expression.isStringLiteral = null;
            parser.enterState(STATE_EXPRESSION);
            return expression;
        }

        function endExpression() {
            var expression = endPart();
            expression.parentState.expression(expression);
        }

        // --------------------------

        // String

        function beginString(quoteChar, quoteCharCode) {
            var string = beginPart();
            string.stringParts = [];
            string.currentText = '';
            string.quoteChar = quoteChar;
            string.quoteCharCode = quoteCharCode;
            string.isStringLiteral = true;
            parser.enterState(STATE_STRING);
            return string;
        }

        function endString() {
            var string = endPart();
            string.parentState.string(string);
        }

        // --------------------------

        // Template String

        function beginTemplateString() {
            var templateString = beginPart();
            templateString.value = '`';
            parser.enterState(STATE_TEMPLATE_STRING);
            return templateString;
        }

        function endTemplateString() {
            var templateString = endPart();
            templateString.parentState.templateString(templateString);
        }

        // --------------------------


        // Scriptlet

        function beginScriptlet() {
            endText();

            var scriptlet = beginPart();
            scriptlet.value = '';
            scriptlet.quoteCharCode = null;
            parser.enterState(STATE_SCRIPTLET);
            return scriptlet;
        }

        function endScriptlet(endPos) {
            var scriptlet = endPart();
            scriptlet.endPos = endPos;
            notifyScriptlet(scriptlet);
        }

        // --------------------------


        // DTD

        function beginDocumentType() {
            endText();

            var documentType = beginPart();
            documentType.value = '';

            parser.enterState(STATE_DTD);
            return documentType;
        }

        function endDocumentType() {
            var documentType = endPart();
            notifyDocumentType(documentType);
        }

        // --------------------------

        // Declaration
        function beginDeclaration() {
            endText();

            var declaration = beginPart();
            declaration.value = '';
            parser.enterState(STATE_DECLARATION);
            return declaration;
        }

        function endDeclaration() {
            var declaration = endPart();
            notifyDeclaration(declaration);
        }

        // --------------------------

        // CDATA

        function beginCDATA() {
            endText();

            var cdata = beginPart();
            cdata.value = '';
            parser.enterState(STATE_CDATA);
            return cdata;
        }

        function endCDATA() {
            var cdata = endPart();
            notifyCDATA(cdata.value, cdata.pos, parser.pos + 3);
        }

        // --------------------------

        // JavaScript Comments
        function beginLineComment() {
            var comment = beginPart();
            comment.value = '';
            comment.type = 'line';
            parser.enterState(STATE_JS_COMMENT_LINE);
            return comment;
        }

        function beginBlockComment() {
            var comment = beginPart();
            comment.value = '';
            comment.type = 'block';
            parser.enterState(STATE_JS_COMMENT_BLOCK);
            return comment;
        }

        function endJavaScriptComment() {
            var comment = endPart();
            comment.rawValue = comment.type === 'line' ?
                '//' + comment.value :
                '/*' + comment.value + '*/';
            comment.parentState.comment(comment);
        }
        // --------------------------

        // HTML Comment

        function beginHtmlComment() {
            endText();
            var comment = beginPart();
            comment.value = '';
            parser.enterState(STATE_HTML_COMMENT);
            return comment;
        }

        function endHtmlComment() {
            var comment = endPart();
            comment.endPos = parser.pos + 3;
            notifyComment(comment);
        }

        // --------------------------

        // Trailing whitespace

        function beginCheckTrailingWhitespace(handler) {
            var part = beginPart();
            part.handler = handler;
            if (typeof handler !== 'function') {
                throw new Error('Invalid handler');
            }
            parser.enterState(STATE_CHECK_TRAILING_WHITESPACE);
        }

        function endCheckTrailingWhitespace(err, eof) {
            var part = endPart();
            part.handler(err, eof);
        }

        function handleTrailingWhitespaceJavaScriptComment(err) {
            if (err) {
                // This is a non-whitespace! We don't allow non-whitespace
                // after matching two or more hyphens. This is user error...
                notifyError(parser.pos,
                    'INVALID_CHARACTER',
                    'A non-whitespace of "' + err.ch + '" was found after a JavaScript block comment.');
            }

            return;
        }

        function handleTrailingWhitespaceMultilineHtmlBlcok(err, eof) {
            if (err) {
                // This is a non-whitespace! We don't allow non-whitespace
                // after matching two or more hyphens. This is user error...
                notifyError(parser.pos,
                    'INVALID_CHARACTER',
                    'A non-whitespace of "' + err.ch + '" was found on the same line as the ending delimiter ("' + htmlBlockDelimiter + '") for a multiline HTML block');
                return;
            }

            endHtmlBlock();

            if (eof) {
                htmlEOF();
            }

            return;
        }

        // --------------------------

        // Placeholder

        function beginPlaceholder(escape, withinTagName) {
            var placeholder = beginPart();
            placeholder.value = '';
            placeholder.escape = escape !== false;
            placeholder.type = 'placeholder';
            placeholder.withinBody = withinOpenTag !== true;
            placeholder.withinAttribute = currentAttribute != null;
            placeholder.withinString = placeholder.parentState === STATE_STRING;
            placeholder.withinOpenTag = withinOpenTag === true && currentAttribute == null;
            placeholder.withinTagName = withinTagName;
            placeholderDepth++;
            parser.enterState(STATE_PLACEHOLDER);
            return placeholder;
        }

        function endPlaceholder() {
            var placeholder = endPart();
            placeholderDepth--;

            var newExpression = notifyPlaceholder(placeholder);
            placeholder.value = newExpression;
            placeholder.parentState.placeholder(placeholder);
        }

        // --------------------------

        // Placeholder

        function beginTagNameShorthand(escape, withinTagName) {
            var shorthand = beginPart();
            shorthand.currentPart = null;
            shorthand.hasId = false;
            shorthand.beginPart = function(type) {
                shorthand.currentPart = {
                    type: type,
                    stringParts: [],
                    text: '',
                    _endText() {
                        if (this.text) {
                            this.stringParts.push(JSON.stringify(this.text));
                        }
                        this.text = '';
                    },
                    addPlaceholder(placeholder) {
                        this._endText();
                        this.stringParts.push('(' + placeholder.value + ')');
                    },
                    end() {
                        this._endText();

                        var expression = this.stringParts.join('+');

                        if (type === 'id') {
                            currentOpenTag.shorthandId = {
                                value: expression
                            };
                        } else if (type === 'class') {
                            if (!currentOpenTag.shorthandClassNames) {
                                currentOpenTag.shorthandClassNames = [];
                            }

                            currentOpenTag.shorthandClassNames.push({
                                value: expression
                            });


                        }
                    }
                };
            };
            parser.enterState(STATE_TAG_NAME_SHORTHAND);
            return shorthand;
        }

        function endTagNameShorthand() {
            var shorthand = endPart();
            if (shorthand.currentPart) {
                shorthand.currentPart.end();
            }
            parser.enterState(STATE_WITHIN_OPEN_TAG);
        }

        // --------------------------

        function getAndRemoveArgument(expression) {
            let start = expression.lastLeftParenPos;
            if (start != null) {
                // The tag has an argument that we need to slice off
                let end = expression.lastRightParenPos;
                if (end === expression.value.length - 1) {
                    var argument = {
                        value: expression.value.substring(start+1, end),
                        pos: expression.pos + start,
                        endPos: expression.pos + end + 1
                    };

                    // Chop off the argument from the expression
                    expression.value = expression.value.substring(0, start);
                    // Fix the end position for the expression
                    expression.endPos = expression.pos + expression.value.length;

                    return argument;
                }
            }

            return undefined;
        }

        // --------------------------

        function checkForPlaceholder(ch, code) {
            if (code === CODE_DOLLAR) {
                var nextCode = parser.lookAtCharCodeAhead(1);
                if (nextCode === CODE_OPEN_CURLY_BRACE) {
                    // We expect to start a placeholder at the first curly brace (the next character)
                    beginPlaceholder(true);
                    return true;
                } else if (nextCode === CODE_EXCLAMATION) {
                    var afterExclamationCode = parser.lookAtCharCodeAhead(2);
                    if (afterExclamationCode === CODE_OPEN_CURLY_BRACE) {
                        // We expect to start a placeholder at the first curly brace so skip
                        // past the exclamation point
                        beginPlaceholder(false);
                        parser.skip(1);
                        return true;
                    }
                }
            }

            return false;
        }

        function checkForEscapedPlaceholder(ch, code) {
            // Look for \${ and \$!{
            if (code === CODE_BACK_SLASH) {
                if (parser.lookAtCharCodeAhead(1) === CODE_DOLLAR) {
                    if (parser.lookAtCharCodeAhead(2) === CODE_OPEN_CURLY_BRACE) {
                        return true;
                    } else if (parser.lookAtCharCodeAhead(2) === CODE_EXCLAMATION) {
                        if (parser.lookAtCharCodeAhead(3) === CODE_OPEN_CURLY_BRACE) {
                            return true;
                        }
                    }
                }
            }

            return false;
        }

        function checkForEscapedEscapedPlaceholder(ch, code) {
            // Look for \\${ and \\$!{
            if (code === CODE_BACK_SLASH) {
                if (parser.lookAtCharCodeAhead(1) === CODE_BACK_SLASH) {
                    if (parser.lookAtCharCodeAhead(2) === CODE_DOLLAR) {
                        if (parser.lookAtCharCodeAhead(3) === CODE_OPEN_CURLY_BRACE) {
                            return true;
                        } else if (parser.lookAtCharCodeAhead(3) === CODE_EXCLAMATION) {
                            if (parser.lookAtCharCodeAhead(4) === CODE_OPEN_CURLY_BRACE) {
                                return true;
                            }
                        }
                    }
                }
            }

            return false;
        }

        function checkForClosingTag() {
            // Look ahead to see if we found the closing tag that will
            // take us out of the EXPRESSION state...
            var lookAhead = '/' + expectedCloseTagName + '>';
            var match = parser.lookAheadFor(lookAhead);
            if (match) {
                endText();
                closeTag(expectedCloseTagName, parser.pos, parser.pos + 1 + lookAhead.length);
                parser.skip(match.length);
                parser.enterState(STATE_HTML_CONTENT);
                return true;
            }

            return false;
        }

        function checkForCDATA() {
            if (parser.lookAheadFor('![CDATA[')) {
                beginCDATA();
                parser.skip(8);
                return true;
            }

            return false;
        }

        function handleDelimitedBlockEOL(newLine) {
            // If we are within a delimited HTML block then we want to check if the next line is the end
            // delimiter. Since we are currently positioned at the start of the new line character our lookahead
            // will need to include the new line character, followed by the expected indentation, followed by
            // the delimiter.
            let endHtmlBlockLookahead = htmlBlockIndent + htmlBlockDelimiter;

            if (parser.lookAheadFor(endHtmlBlockLookahead, parser.pos + newLine.length)) {
                parser.skip(htmlBlockIndent.length);
                parser.skip(htmlBlockDelimiter.length);

                parser.enterState(STATE_CONCISE_HTML_CONTENT);

                beginCheckTrailingWhitespace(handleTrailingWhitespaceMultilineHtmlBlcok);
                return;
            } else if (parser.lookAheadFor(htmlBlockIndent, parser.pos + newLine.length)) {
                // We know the next line does not end the multiline HTML block, but we need to check if there
                // is any indentation that we need to skip over as we continue parsing the HTML in this
                // multiline HTML block

                parser.skip(htmlBlockIndent.length);
                // We stay in the same state since we are still parsing a multiline, delimited HTML block
            }
        }

        // In STATE_HTML_CONTENT we are looking for tags and placeholders but
        // everything in between is treated as text.
        var STATE_HTML_CONTENT = Parser.createState({
            name: 'STATE_HTML_CONTENT',

            placeholder(placeholder) {
                // We found a placeholder while parsing the HTML content. This function is called
                // from endPlaceholder(). We have already notified the listener of the placeholder so there is
                // nothing to do here
            },

            eol(newLine) {
                text += newLine;

                if (beginMixedMode) {
                    beginMixedMode = false;
                    endHtmlBlock();
                } else if (endingMixedModeAtEOL) {
                    endingMixedModeAtEOL = false;
                    endHtmlBlock();
                } else if (isWithinSingleLineHtmlBlock) {
                    // We are parsing "HTML" and we reached the end of the line. If we are within a single
                    // line HTML block then we should return back to the state to parse concise HTML.
                    // A single line HTML block can be at the end of the tag or on its own line:
                    //
                    // span class="hello" - This is an HTML block at the end of a tag
                    //     - This is an HTML block on its own line
                    //
                    endHtmlBlock();
                } else if (htmlBlockDelimiter) {
                    handleDelimitedBlockEOL(newLine);
                }
            },

            eof: htmlEOF,

            enter() {
                isConcise = false; // Back into non-concise HTML parsing
            },

            char(ch, code) {
                if (code === CODE_OPEN_ANGLE_BRACKET) {
                    if (checkForCDATA()) {
                        return;
                    }

                    var nextCode = parser.lookAtCharCodeAhead(1);

                    if (nextCode === CODE_PERCENT) {
                        beginScriptlet();
                        parser.skip(1);
                    } else if (parser.lookAheadFor('!--')) {
                        beginHtmlComment();
                        parser.skip(3);
                    } else if (nextCode === CODE_EXCLAMATION) {
                        // something like:
                        // <!DOCTYPE html>
                        // NOTE: We already checked for CDATA earlier and <!--
                        beginDocumentType();
                        parser.skip(1);
                    } else if (nextCode === CODE_QUESTION) {
                        // something like:
                        // <?xml version="1.0"?>
                        beginDeclaration();
                        parser.skip(1);
                    } else if (nextCode === CODE_FORWARD_SLASH) {
                        closeTagPos = parser.pos;
                        closeTagName = null;

                        parser.skip(1);
                        // something like:
                        // </html>
                        endText();

                        parser.enterState(STATE_CLOSE_TAG);
                    } else if (nextCode === CODE_CLOSE_ANGLE_BRACKET ||
                               nextCode === CODE_OPEN_ANGLE_BRACKET ||
                               isWhitespaceCode(nextCode)) {
                        // something like:
                        // "<>"
                        // "<<"
                        // "< "
                        // We'll treat this left angle brakect as text
                        text += '<';
                    } else {
                        beginOpenTag();
                        currentOpenTag.tagNameStart = parser.pos+1;
                    }
                } else if (!ignorePlaceholders && checkForEscapedEscapedPlaceholder(ch, code)) {
                    text += '\\';
                    parser.skip(1);
                }  else if (!ignorePlaceholders && checkForEscapedPlaceholder(ch, code)) {
                    text += '$';
                    parser.skip(1);
                } else if (!ignorePlaceholders && checkForPlaceholder(ch, code)) {
                    // We went into placeholder state...
                    endText();
                } else {
                    text += ch;
                }
            }
        });

        // In STATE_CONCISE_HTML_CONTENT we are looking for concise tags and text blocks based on indent
        var STATE_CONCISE_HTML_CONTENT = Parser.createState({
            name: 'STATE_CONCISE_HTML_CONTENT',

            eol(newLine) {
                text += newLine;
            },

            eof: htmlEOF,

            enter() {
                isConcise = true;
                indent = '';
            },

            comment(comment) {
                var value = comment.value;

                value = value.trim();

                notifyComment({
                    value: value,
                    pos: comment.pos,
                    endPos: comment.endPos
                });

                if (comment.type === 'block') {
                    // Make sure there is only whitespace on the line
                    // after the ending "*/" sequence
                    beginCheckTrailingWhitespace(handleTrailingWhitespaceJavaScriptComment);
                }
            },

            endTrailingWhitespace(eof) {
                endHtmlBlock();

                if (eof) {
                    htmlEOF();
                }
            },

            char(ch, code) {
                if (isWhitespaceCode(code)) {
                    indent += ch;
                } else  {
                    while(true) {
                        let len = blockStack.length;
                        if (len) {
                            let curBlock = blockStack[len - 1];
                            if (curBlock.indent.length >= indent.length) {
                                closeTag(curBlock.expectedCloseTagName);
                            } else {
                                // Indentation is greater than the last tag so we are starting a
                                // nested tag and there are no more tags to end
                                break;
                            }
                        } else {
                            if (indent) {
                                notifyError(parser.pos,
                                    'BAD_INDENTATION',
                                    'Line has extra indentation at the beginning');
                                return;
                            }
                            break;
                        }
                    }

                    var parent = blockStack.length && blockStack[blockStack.length - 1];
                    var body;

                    if (parent) {
                        body = parent.body;
                        if (parent.openTagOnly) {
                            notifyError(parser.pos,
                                'INVALID_BODY',
                                'The "' + parent.tagName + '" tag does not allow nested body content');
                            return;
                        }

                        if (parent.nestedIndent) {
                            if (parent.nestedIndent.length !== indent.length) {
                                notifyError(parser.pos,
                                    'BAD_INDENTATION',
                                    'Line indentation does match indentation of previous line');
                                return;
                            }
                        } else {
                            parent.nestedIndent = indent;
                        }
                    }

                    if (body && code !== CODE_HTML_BLOCK_DELIMITER) {
                        notifyError(parser.pos,
                            'ILLEGAL_LINE_START',
                            'A line within a tag that only allows text content must begin with a "-" character');
                        return;
                    }

                    if (code === CODE_OPEN_ANGLE_BRACKET || code === CODE_DOLLAR) {
                        beginMixedMode = true;
                        parser.rewind(1);
                        beginHtmlBlock();
                        return;
                    }

                    if (code === CODE_HTML_BLOCK_DELIMITER) {
                        if (parser.lookAtCharCodeAhead(1) === CODE_HTML_BLOCK_DELIMITER) {
                            // Two or more HTML block delimiters means we are starting a multiline, delimited HTML block
                            htmlBlockDelimiter = ch;
                            // We enter the following state to read in the full delimiter
                            return parser.enterState(STATE_BEGIN_DELIMITED_HTML_BLOCK);
                        } else {

                            if (parser.lookAtCharCodeAhead(1) === CODE_SPACE) {
                                // We skip over the first space
                                parser.skip(1);
                            }
                            isWithinSingleLineHtmlBlock = true;
                            beginHtmlBlock();
                        }
                    } else if (code === CODE_FORWARD_SLASH) {
                        // Check next character to see if we are in a comment
                        var nextCode = parser.lookAtCharCodeAhead(1);
                        if (nextCode === CODE_FORWARD_SLASH) {
                            beginLineComment();
                            parser.skip(1);
                            return;
                        } else if (nextCode === CODE_ASTERISK) {
                            beginBlockComment();
                            parser.skip(1);
                            return;
                        } else {
                            notifyError(parser.pos,
                                'ILLEGAL_LINE_START',
                                'A line in concise mode cannot start with "/" unless it starts a "//" or "/*" comment');
                            return;
                        }
                    } else {
                        beginOpenTag();
                        currentOpenTag.tagNameStart = parser.pos;
                        parser.rewind(1); // START_TAG_NAME expects to start at the first character
                    }
                }
            }
        });

        // In STATE_BEGIN_DELIMITED_HTML_BLOCK we have already found two consecutive hyphens. We expect
        // to reach the end of the line with only whitespace characters
        var STATE_BEGIN_DELIMITED_HTML_BLOCK = Parser.createState({
            name: 'STATE_BEGIN_DELIMITED_HTML_BLOCK',

            eol: function(newLine) {
                // We have reached the end of the first delimiter... we need to skip over any indentation on the next
                // line and we might also find that the multi-line, delimited block is immediately ended
                beginHtmlBlock(htmlBlockDelimiter);
                handleDelimitedBlockEOL(newLine);
            },

            eof: htmlEOF,

            char(ch, code) {
                if (code === CODE_HTML_BLOCK_DELIMITER) {
                    htmlBlockDelimiter += ch;
                } else if (isWhitespaceCode(code)) {
                    // Just whitespace... we are still good
                } else {
                    // This is a non-whitespace! We don't allow non-whitespace
                    // after matching two or more hyphens. This is user error...
                    notifyError(parser.pos,
                        'MALFORMED_MULTILINE_HTML_BLOCK',
                        'A non-whitespace of "' + ch + '" was found on the same line as a multiline HTML block delimiter ("' + htmlBlockDelimiter + '")');
                }
            }
        });

        var STATE_CHECK_TRAILING_WHITESPACE = Parser.createState({
            name: 'STATE_CHECK_TRAILING_WHITESPACE',

            eol: function() {
                endCheckTrailingWhitespace(null /* no error */, false /* not EOF */);
            },

            eof: function() {
                endCheckTrailingWhitespace(null /* no error */, true /* EOF */);
            },

            char(ch, code) {
                if (isWhitespaceCode(code)) {
                    // Just whitespace... we are still good
                } else {
                    endCheckTrailingWhitespace({
                        ch: ch
                    });
                }
            }
        });

        // We enter STATE_STATIC_TEXT_CONTENT when a listener manually chooses
        // to enter this state after seeing an openTag event for a tag
        // whose content should not be parsed at all (except for the purpose
        // of looking for the end tag).
        var STATE_STATIC_TEXT_CONTENT = Parser.createState({
            name: 'STATE_STATIC_TEXT_CONTENT',

            eol(newLine) {
                text += newLine;

                if (isWithinSingleLineHtmlBlock) {
                    // We are parsing "HTML" and we reached the end of the line. If we are within a single
                    // line HTML block then we should return back to the state to parse concise HTML.
                    // A single line HTML block can be at the end of the tag or on its own line:
                    //
                    // span class="hello" - This is an HTML block at the end of a tag
                    //     - This is an HTML block on its own line
                    //
                    endHtmlBlock();
                } else if (htmlBlockDelimiter) {
                    handleDelimitedBlockEOL(newLine);
                }
            },

            eof: htmlEOF,

            char(ch, code) {
                // See if we need to see if we reached the closing tag...
                if (!isConcise && code === CODE_OPEN_ANGLE_BRACKET) {
                    if (checkForClosingTag()) {
                        return;
                    }
                }

                text += ch;
            }
        });

        // We enter STATE_PARSED_TEXT_CONTENT when we are parsing
        // the body of a tag does not contain HTML tags but may contains
        // placeholders
        var STATE_PARSED_TEXT_CONTENT = Parser.createState({
            name: 'STATE_PARSED_TEXT_CONTENT',

            placeholder: STATE_HTML_CONTENT.placeholder,

            eol(newLine) {
                text += newLine;

                if (isWithinSingleLineHtmlBlock) {
                    // We are parsing "HTML" and we reached the end of the line. If we are within a single
                    // line HTML block then we should return back to the state to parse concise HTML.
                    // A single line HTML block can be at the end of the tag or on its own line:
                    //
                    // span class="hello" - This is an HTML block at the end of a tag
                    //     - This is an HTML block on its own line
                    //
                    endHtmlBlock();
                } else if (htmlBlockDelimiter) {
                    handleDelimitedBlockEOL(newLine);
                }
            },

            eof: htmlEOF,

            char(ch, code) {
                if (!isConcise && code === CODE_OPEN_ANGLE_BRACKET) {
                    // First, see if we need to see if we reached the closing tag
                    // and then check if we encountered CDATA
                    if (checkForClosingTag()) {
                        return;
                    } else if (checkForCDATA()) {
                        return;
                    } else if (parser.lookAtCharCodeAhead(1) === CODE_PERCENT) {
                        beginScriptlet();
                        parser.skip(1);
                        return;
                    }
                } else if (!ignorePlaceholders && checkForEscapedEscapedPlaceholder(ch, code)) {
                    text += '\\';
                    parser.skip(1);
                }  else if (!ignorePlaceholders && checkForEscapedPlaceholder(ch, code)) {
                    text += '$';
                    parser.skip(1);
                } else if (!ignorePlaceholders && checkForPlaceholder(ch, code)) {
                    // We went into placeholder state...
                    endText();
                    return;
                }

                text += ch;
            }
        });

        // We enter STATE_TAG_NAME after we encounter a "<"
        // followed by a non-special character
        var STATE_TAG_NAME = Parser.createState({
            name: 'STATE_TAG_NAME',

            eol: openTagEOL,

            eof: openTagEOF,

            expression(expression) {
                var argument = getAndRemoveArgument(expression);

                if (argument) {
                    // The tag has an argument that we need to slice off

                    if (currentOpenTag.argument != null) {
                        notifyError(expression.endPos,
                            'ILLEGAL_TAG_ARGUMENT',
                            'A tag can only have one argument');
                    }

                    currentOpenTag.argument = argument;
                    currentOpenTag.tagNameEnd = expression.pos + expression.lastLeftParenPos + 1;
                } else {
                    currentOpenTag.tagNameEnd = expression.endPos;
                }


                if (expression.value) {
                    currentOpenTag.tagName += expression.value;

                    if (currentOpenTag.tagNameParts) {
                        currentOpenTag.tagNameParts.push(JSON.stringify(expression.value));
                    }
                }
            },

            placeholder(placeholder) {
                if (!currentOpenTag.tagNameParts) {
                    currentOpenTag.tagNameParts = [];

                    if (currentOpenTag.tagName) {
                        currentOpenTag.tagNameParts.push(JSON.stringify(currentOpenTag.tagName));
                    }
                }

                currentOpenTag.tagName += parser.substring(placeholder.pos, placeholder.endPos);
                currentOpenTag.tagNameParts.push('(' + placeholder.value + ')');
                currentOpenTag.tagNameEnd = placeholder.endPos;
            },

            enter(oldState) {
                if (oldState !== STATE_EXPRESSION) {
                    beginExpression();
                }
            },

            char(ch, code) {
                throw new Error('Illegal state');
            }
        });



        // We enter STATE_CDATA after we see "<![CDATA["
        var STATE_CDATA = Parser.createState({
            name: 'STATE_CDATA',

            eof() {
                notifyError(currentPart.pos,
                    'MALFORMED_CDATA',
                    'EOF reached while parsing CDATA');
            },

            char(ch, code) {
                if (code === CODE_CLOSE_SQUARE_BRACKET) {
                    var match = parser.lookAheadFor(']>');
                    if (match) {
                        endCDATA();
                        parser.skip(match.length);
                        return;
                    }
                }

                currentPart.value += ch;
            }
        });

        // We enter STATE_CLOSE_TAG after we see "</"
        var STATE_CLOSE_TAG = Parser.createState({
            name: 'STATE_CLOSE_TAG',
            eof() {
                notifyError(closeTag.pos,
                    'MALFORMED_CLOSE_TAG',
                    'EOF reached while parsing closing tag');
            },

            enter() {
                closeTagName = '';
            },

            char(ch, code) {
                if (code === CODE_CLOSE_ANGLE_BRACKET) {
                    if (closeTagName.length > 0) {
                        closeTag(closeTagName, closeTagPos, parser.pos + 1);
                    } else {
                        closeTag(expectedCloseTagName, closeTagPos, parser.pos + 1);
                    }

                    parser.enterState(STATE_HTML_CONTENT);
                } else {
                    closeTagName += ch;
                }
            }
        });

        // We enter STATE_WITHIN_OPEN_TAG after we have fully
        // read in the tag name and encountered a whitespace character
        var STATE_WITHIN_OPEN_TAG = Parser.createState({
            name: 'STATE_WITHIN_OPEN_TAG',

            eol: openTagEOL,

            eof: openTagEOF,

            expression(expression) {
                var argument = getAndRemoveArgument(expression);

                if (argument) {
                    // We found an argument... the argument could be for an attribute or the tag
                    if (currentOpenTag.attributes.length === 0) {
                        if (currentOpenTag.argument != null) {
                            notifyError(expression.endPos,
                                'ILLEGAL_TAG_ARGUMENT',
                                'A tag can only have one argument');
                            return;
                        }
                        currentOpenTag.argument = argument;
                    } else {
                        let targetAttribute = currentAttribute || peek(currentOpenTag.attributes);

                        if (targetAttribute.argument != null) {
                            notifyError(expression.endPos,
                                'ILLEGAL_ATTRIBUTE_ARGUMENT',
                                'An attribute can only have one argument');
                            return;
                        }
                        targetAttribute.argument = argument;
                    }
                }
            },

            placeholder(placeholder) {
                var attr = beginAttribute();
                attr.value = placeholder.value;
                endAttribute();

                parser.enterState(STATE_AFTER_PLACEHOLDER_WITHIN_TAG);
            },

            comment(comment) {
                /* Ignore comments within an open tag */
            },

            char(ch, code) {

                if (isConcise) {
                    if (code === CODE_HTML_BLOCK_DELIMITER) {
                        if (currentOpenTag.withinAttrGroup) {
                            notifyError(currentOpenTag.pos,
                                'MALFORMED_OPEN_TAG',
                                'Attribute group was not properly ended');
                            return;
                        }

                        // The open tag is complete
                        finishOpenTag();

                        let nextCode = parser.lookAtCharCodeAhead(1);
                        if (nextCode !== CODE_NEWLINE && nextCode !== CODE_CARRIAGE_RETURN &&
                            isWhitespaceCode(nextCode)) {
                            // We want to remove the first whitespace character after the `-` symbol
                            parser.skip(1);
                        }

                        isWithinSingleLineHtmlBlock = true;
                        beginHtmlBlock();
                        return;
                    } else if (code === CODE_OPEN_SQUARE_BRACKET) {
                        if (currentOpenTag.withinAttrGroup) {
                            notifyError(parser.pos,
                                'MALFORMED_OPEN_TAG',
                                'Unexpected "[" character within open tag.');
                            return;
                        }

                        currentOpenTag.withinAttrGroup = true;
                        return;
                    } else if (code === CODE_CLOSE_SQUARE_BRACKET) {
                        if (!currentOpenTag.withinAttrGroup) {
                            notifyError(parser.pos,
                                'MALFORMED_OPEN_TAG',
                                'Unexpected "]" character within open tag.');
                            return;
                        }

                        currentOpenTag.withinAttrGroup = false;
                        return;
                    }
                } else {
                    if (code === CODE_CLOSE_ANGLE_BRACKET) {
                        finishOpenTag();
                        return;
                    } else if (code === CODE_FORWARD_SLASH) {
                        let nextCode = parser.lookAtCharCodeAhead(1);
                        if (nextCode === CODE_CLOSE_ANGLE_BRACKET) {
                            finishOpenTag(true /* self closed */);
                            parser.skip(1);
                            return;
                        }
                    }
                }

                if (checkForEscapedEscapedPlaceholder(ch, code)) {
                    let attr = beginAttribute();
                    attr.name = '\\';
                    parser.skip(1);
                    return;
                }  else if (checkForEscapedPlaceholder(ch, code)) {
                    let attr = beginAttribute();
                    attr.name = '$';
                    parser.skip(1);
                    return;
                } else if (checkForPlaceholder(ch, code)) {
                    return;
                }

                if (code === CODE_OPEN_ANGLE_BRACKET) {
                    return notifyError(parser.pos,
                        'ILLEGAL_ATTRIBUTE_NAME',
                        'Invalid attribute name. Attribute name cannot begin with the "<" character.');
                }

                if (code === CODE_FORWARD_SLASH && parser.lookAtCharCodeAhead(1) === CODE_ASTERISK) {
                    // Skip over code inside a JavaScript block comment
                    beginBlockComment();
                    parser.skip(1);
                    return;
                }

                if (isWhitespaceCode(code)) {
                    // ignore whitespace within element...
                } else if (code === CODE_OPEN_PAREN) {
                    parser.rewind(1);
                    beginExpression();
                    // encountered something like:
                    // <for (var i = 0; i < len; i++)>
                } else {
                    parser.rewind(1);
                    // attribute name is initially the first non-whitespace
                    // character that we found
                    beginAttribute();
                }
            }
        });

        // We enter STATE_ATTRIBUTE_NAME when we see a non-whitespace
        // character after reading the tag name
        var STATE_ATTRIBUTE_NAME = Parser.createState({
            name: 'STATE_ATTRIBUTE_NAME',

            eol: openTagEOL,

            eof: openTagEOF,

            expression(expression) {
                var argument = getAndRemoveArgument(expression);
                if (argument) {
                    // The tag has an argument that we need to slice off
                    currentAttribute.argument = argument;
                }

                currentAttribute.name = currentAttribute.name ? currentAttribute.name + expression.value : expression.value;
                currentAttribute.pos = expression.pos;
                currentAttribute.endPos = expression.endPos;
            },

            enter(oldState) {
                if (oldState !== STATE_EXPRESSION) {
                    beginExpression();
                }
            },

            char(ch, code) {
                throw new Error('Illegal state');
            }
        });

        // We enter STATE_ATTRIBUTE_VALUE when we see a "=" while in
        // the ATTRIBUTE_NAME state.
        var STATE_ATTRIBUTE_VALUE = Parser.createState({
            name: 'STATE_ATTRIBUTE_VALUE',

            expression(expression) {
                var value = expression.value;

                if (value === '') {

                    return notifyError(expression.pos,
                        'ILLEGAL_ATTRIBUTE_VALUE',
                        'No attribute value found after "="');
                }
                currentAttribute.value = value;
                currentAttribute.pos = expression.pos;
                currentAttribute.endPos = expression.endPos;

                // If the expression evaluates to a literal value then add the
                // `literalValue` property to the attribute
                if (expression.isStringLiteral) {
                    currentAttribute.literalValue = evaluateStringExpression(value, expression.pos, notifyError);
                } else if (value === 'true') {
                    currentAttribute.literalValue = true;
                } else if (value === 'false') {
                    currentAttribute.literalValue = false;
                } else if (value === 'null') {
                    currentAttribute.literalValue = null;
                } else if (value === 'undefined') {
                    currentAttribute.literalValue = undefined;
                } else if (NUMBER_REGEX.test(value)) {
                    currentAttribute.literalValue = Number(value);
                }

                // We encountered a whitespace character while parsing the attribute name. That
                // means the attribute name has ended and we should continue parsing within the
                // open tag
                endAttribute();
            },

            eol: openTagEOL,

            eof: openTagEOF,

            enter(oldState) {
                if (oldState !== STATE_EXPRESSION) {
                    beginExpression();
                }
            },

            char(ch, code) {
                throw new Error('Illegal state');
            }
        });

        var STATE_EXPRESSION = Parser.createState({
            name: 'STATE_EXPRESSION',

            eol(str) {
                let depth = currentPart.groupStack.length;

                if (depth === 0) {
                    if (currentPart.parentState === STATE_ATTRIBUTE_NAME || currentPart.parentState === STATE_ATTRIBUTE_VALUE) {
                        currentPart.endPos = parser.pos;
                        endExpression();
                        // We encountered a whitespace character while parsing the attribute name. That
                        // means the attribute name has ended and we should continue parsing within the
                        // open tag
                        endAttribute();

                        if (isConcise) {
                            openTagEOL();
                        }
                        return;
                    } else if (currentPart.parentState === STATE_TAG_NAME) {
                        currentPart.endPos = parser.pos;
                        endExpression();

                        // We encountered a whitespace character while parsing the attribute name. That
                        // means the attribute name has ended and we should continue parsing within the
                        // open tag
                        if (parser.state !== STATE_WITHIN_OPEN_TAG) {
                            // Make sure we transition into parsing within the open tag
                            parser.enterState(STATE_WITHIN_OPEN_TAG);
                        }

                        if (isConcise) {
                            openTagEOL();
                        }

                        return;
                    }
                }

                currentPart.value += str;
            },

            eof() {
                if (isConcise && currentPart.groupStack.length === 0) {
                    currentPart.endPos = parser.pos;
                    endExpression();
                    openTagEOF();
                } else {
                    let parentState = currentPart.parentState;

                    if (parentState === STATE_ATTRIBUTE_NAME) {
                        return notifyError(currentPart.pos,
                            'MALFORMED_OPEN_TAG',
                            'EOF reached while parsing attribute name for the "' + currentOpenTag.tagName + '" tag');
                    } else if (parentState === STATE_ATTRIBUTE_VALUE) {
                        return notifyError(currentPart.pos,
                            'MALFORMED_OPEN_TAG',
                            'EOF reached while parsing attribute value for the "' + currentAttribute.name + '" attribute');
                    } else if (parentState === STATE_TAG_NAME) {
                        return notifyError(currentPart.pos,
                            'MALFORMED_OPEN_TAG',
                            'EOF reached while parsing tag name');
                    } else if (parentState === STATE_PLACEHOLDER) {
                        return notifyError(currentPart.pos,
                            'MALFORMED_PLACEHOLDER',
                            'EOF reached while parsing placeholder');
                    }

                    return notifyError(currentPart.pos,
                        'INVALID_EXPRESSION',
                        'EOF reached will parsing expression');
                }
            },

            string(string) {
                if (currentPart.value === '') {
                    currentPart.isStringLiteral = string.isStringLiteral === true;
                } else {
                    // More than one strings means it is for sure not a string literal...
                    currentPart.isStringLiteral = false;
                }

                currentPart.value += string.value;
            },

            comment(comment) {
                currentPart.isStringLiteral = false;
                currentPart.value += comment.rawValue;
            },

            templateString(templateString) {
                currentPart.isStringLiteral = false;
                currentPart.value += templateString.value;
            },

            char(ch, code) {
                let depth = currentPart.groupStack.length;
                let parentState = currentPart.parentState;

                if (code === CODE_SINGLE_QUOTE) {
                    return beginString("'", CODE_SINGLE_QUOTE);
                } else if (code === CODE_DOUBLE_QUOTE) {
                    return beginString('"', CODE_DOUBLE_QUOTE);
                } else if (code === CODE_BACKTICK) {
                    return beginTemplateString();
                } else if (code === CODE_FORWARD_SLASH) {
                    // Check next character to see if we are in a comment
                    var nextCode = parser.lookAtCharCodeAhead(1);
                    if (nextCode === CODE_FORWARD_SLASH) {
                        beginLineComment();
                        parser.skip(1);
                        return;
                    } else if (nextCode === CODE_ASTERISK) {

                        beginBlockComment();
                        parser.skip(1);
                        return;
                    } else if (depth === 0 && !isConcise && nextCode === CODE_CLOSE_ANGLE_BRACKET) {
                        // Let the STATE_WITHIN_OPEN_TAG state deal with the ending tag sequence
                        currentPart.endPos = parser.pos;
                        endExpression();
                        parser.rewind(1);

                        if (parser.state !== STATE_WITHIN_OPEN_TAG) {
                            // Make sure we transition into parsing within the open tag
                            parser.enterState(STATE_WITHIN_OPEN_TAG);
                        }
                        return;
                    }
                } else if (code === CODE_OPEN_PAREN ||
                           code === CODE_OPEN_SQUARE_BRACKET ||
                           code === CODE_OPEN_CURLY_BRACE) {

                    if (depth === 0 && code === CODE_OPEN_PAREN) {
                        currentPart.lastLeftParenPos = currentPart.value.length;
                    }

                    currentPart.groupStack.push(code);
                    currentPart.isStringLiteral = false;
                    currentPart.value += ch;
                    return;
                } else if (code === CODE_CLOSE_PAREN ||
                           code === CODE_CLOSE_SQUARE_BRACKET ||
                           code === CODE_CLOSE_CURLY_BRACE) {

                    if (depth === 0) {
                        if (code === CODE_CLOSE_SQUARE_BRACKET) {
                            // We are ending the attribute group so end this expression and let the
                            // STATE_WITHIN_OPEN_TAG state deal with the ending attribute group
                            if (currentOpenTag.withinAttrGroup) {
                                currentPart.endPos = parser.pos + 1;
                                endExpression();
                                // Let the STATE_WITHIN_OPEN_TAG state deal with the ending tag sequence
                                parser.rewind(1);
                                if (parser.state !== STATE_WITHIN_OPEN_TAG) {
                                    // Make sure we transition into parsing within the open tag
                                    parser.enterState(STATE_WITHIN_OPEN_TAG);
                                }
                                return;
                            }
                        } else {
                            return notifyError(currentPart.pos,
                                'INVALID_EXPRESSION',
                                'Mismatched group. A closing "' + ch + '" character was found but it is not matched with a corresponding opening character.');
                        }
                    }


                    let matchingGroupCharCode = currentPart.groupStack.pop();

                    if ((code === CODE_CLOSE_PAREN && matchingGroupCharCode !== CODE_OPEN_PAREN) ||
                        (code === CODE_CLOSE_SQUARE_BRACKET && matchingGroupCharCode !== CODE_OPEN_SQUARE_BRACKET) ||
                        (code === CODE_CLOSE_CURLY_BRACE && matchingGroupCharCode !== CODE_OPEN_CURLY_BRACE)) {
                            return notifyError(currentPart.pos,
                                'INVALID_EXPRESSION',
                                'Mismatched group. A "' + ch + '" character was found when "' + String.fromCharCode(matchingGroupCharCode) + '" was expected.');
                    }

                    currentPart.value += ch;

                    if (currentPart.groupStack.length === 0) {
                        if (code === CODE_CLOSE_PAREN) {
                            currentPart.lastRightParenPos = currentPart.value.length - 1;
                        } else if (code === CODE_CLOSE_CURLY_BRACE && parentState === STATE_PLACEHOLDER) {
                            currentPart.endPos = parser.pos + 1;
                            endExpression();
                            return;
                        }
                    }

                    return;
                } else if (depth === 0) {
                    if (!isConcise) {
                        if (code === CODE_CLOSE_ANGLE_BRACKET &&
                            (parentState === STATE_TAG_NAME ||
                             parentState === STATE_ATTRIBUTE_NAME ||
                             parentState === STATE_ATTRIBUTE_VALUE ||
                             parentState === STATE_WITHIN_OPEN_TAG)) {
                            currentPart.endPos = parser.pos;
                            endExpression();
                            endAttribute();
                            // Let the STATE_WITHIN_OPEN_TAG state deal with the ending tag sequence
                            parser.rewind(1);
                            if (parser.state !== STATE_WITHIN_OPEN_TAG) {
                                // Make sure we transition into parsing within the open tag
                                parser.enterState(STATE_WITHIN_OPEN_TAG);
                            }
                            return;
                        }
                    }

                    if (isWhitespaceCode(code)) {
                        currentPart.endPos = parser.pos;
                        endExpression();
                        endAttribute();
                        if (parser.state !== STATE_WITHIN_OPEN_TAG) {
                            // Make sure we transition into parsing within the open tag
                            parser.enterState(STATE_WITHIN_OPEN_TAG);
                        }
                        return;
                    } else if (code === CODE_EQUAL && parentState === STATE_ATTRIBUTE_NAME) {
                        currentPart.endPos = parser.pos;
                        endExpression();
                        // We encountered "=" which means we need to start reading
                        // the attribute value.
                        parser.enterState(STATE_ATTRIBUTE_VALUE);
                        return;
                    }

                    if (currentPart.parentState === STATE_TAG_NAME) {
                        if (checkForEscapedEscapedPlaceholder(ch, code)) {
                            currentPart.value += '\\';
                            parser.skip(1);
                            return;
                        }  else if (checkForEscapedPlaceholder(ch, code)) {
                            currentPart.value += '$';
                            parser.skip(1);
                            return;
                        } else if (code === CODE_DOLLAR && parser.lookAtCharCodeAhead(1) === CODE_OPEN_CURLY_BRACE) {
                            currentPart.endPos = parser.pos;
                            endExpression();
                            // We expect to start a placeholder at the first curly brace (the next character)
                            beginPlaceholder(true, true /* tag name */);
                            return;
                        } else if (code === CODE_PERIOD || code === CODE_NUMBER_SIGN) {
                            endExpression();
                            parser.rewind(1);
                            beginTagNameShorthand();
                            return;
                        }
                    }
                }

                currentPart.value += ch;
            }
        });

        var STATE_TAG_NAME_SHORTHAND = Parser.createState({
            name: 'STATE_TAG_NAME_SHORTHAND',

            placeholder(placeholder) {
                var shorthand = currentPart;
                shorthand.currentPart.addPlaceholder(placeholder);
            },

            eol(str) {
                currentOpenTag.tagNameEnd = parser.pos;
                endTagNameShorthand();

                if (parser.state !== STATE_WITHIN_OPEN_TAG) {
                    // Make sure we transition into parsing within the open tag
                    parser.enterState(STATE_WITHIN_OPEN_TAG);
                }

                if (isConcise) {
                    openTagEOL();
                }
            },

            eof() {
                endTagNameShorthand();

                if (isConcise) {
                    openTagEOF();
                } else {
                    return notifyError(currentPart.pos,
                        'INVALID_TAG_SHORTHAND',
                        'EOF reached will parsing id/class shorthand in tag name');
                }
            },

            char(ch, code) {
                var shorthand = currentPart;
                if (!isConcise) {
                    if (code === CODE_CLOSE_ANGLE_BRACKET || code === CODE_FORWARD_SLASH) {
                        currentOpenTag.tagNameEnd = parser.pos;
                        endTagNameShorthand();
                        parser.rewind(1);
                        return;
                    }
                }

                if (isWhitespaceCode(code)) {
                    endTagNameShorthand();
                    currentOpenTag.tagNameEnd = parser.pos;
                    if (parser.state !== STATE_WITHIN_OPEN_TAG) {
                        parser.enterState(STATE_WITHIN_OPEN_TAG);
                    }
                    return;
                }

                if (code === CODE_PERIOD) {
                    if (shorthand.currentPart) {
                        shorthand.currentPart.end();
                    }

                    shorthand.beginPart('class');
                } else if (code === CODE_NUMBER_SIGN) {
                    if (shorthand.hasId) {
                        return notifyError(currentPart.pos,
                            'INVALID_TAG_SHORTHAND',
                            'Multiple shorthand ID parts are not allowed on the same tag');
                    }

                    shorthand.hasId = true;

                    if (shorthand.currentPart) {
                        shorthand.currentPart.end();
                    }

                    shorthand.beginPart('id');
                }

                else if (!ignorePlaceholders && checkForEscapedEscapedPlaceholder(ch, code)) {
                    shorthand.currentPart.text += '\\';
                    parser.skip(1);
                }  else if (!ignorePlaceholders && checkForEscapedPlaceholder(ch, code)) {
                    shorthand.currentPart.text += '$';
                    parser.skip(1);
                } else if (!ignorePlaceholders && checkForPlaceholder(ch, code)) {
                    // We went into placeholder state...
                } else {
                    shorthand.currentPart.text += ch;
                }
            }
        });

        // We enter STATE_WITHIN_OPEN_TAG after we have fully
        // read in the tag name and encountered a whitespace character
        var STATE_AFTER_PLACEHOLDER_WITHIN_TAG = Parser.createState({
            name: 'STATE_AFTER_PLACEHOLDER_WITHIN_TAG',

            eol: openTagEOL,

            eof: openTagEOF,

            char(ch, code) {

                if (!isConcise) {
                    if (code === CODE_CLOSE_ANGLE_BRACKET) {
                        finishOpenTag();
                        return;
                    } else if (code === CODE_FORWARD_SLASH) {
                        let nextCode = parser.lookAtCharCodeAhead(1);
                        if (nextCode === CODE_CLOSE_ANGLE_BRACKET) {
                            finishOpenTag(true /* self closed */);
                            parser.skip(1);
                            return;
                        }
                    }
                }

                if (isWhitespaceCode(code)) {
                    parser.enterState(STATE_WITHIN_OPEN_TAG);
                } else {
                    notifyError(parser.pos,
                        'UNEXPECTED_TEXT_AFTER_PLACEHOLDER_IN_TAG',
                        `An unexpected "${ch}" character was found after a placeoholder within the open tag.`);
                    return;
                }
            }
        });

        var STATE_PLACEHOLDER = Parser.createState({
            name: 'STATE_PLACEHOLDER',

            expression(expression) {
                currentPart.value = expression.value.slice(1, -1); // Chop off the curly braces
                currentPart.endPos = expression.endPos;
                endPlaceholder();
            },

            eol(str) {
                throw new Error('Illegal state. EOL not expected');
            },

            eof() {
                throw new Error('Illegal state. EOF not expected');
            },

            enter(oldState) {
                if (oldState !== STATE_EXPRESSION) {
                    beginExpression();
                }
            }
        });

        var STATE_STRING = Parser.createState({
            name: 'STATE_STRING',

            placeholder(placeholder) {
                if (currentPart.currentText) {
                    currentPart.stringParts.push(currentPart.currentText);
                    currentPart.currentText = '';
                }
                currentPart.isStringLiteral = false;
                currentPart.stringParts.push(placeholder);
            },

            eol(str) {
                // New line characters are not allowed in JavaScript string expressions. We need to use
                // a different character sequence, but we don't want to through off positions so we need
                // to use a replacement sequence with the same number of characters.
                if (str.length === 2) {
                    currentPart.currentText += '\\r\\n';
                } else {
                    currentPart.currentText += '\\n';
                }

            },

            eof() {
                if (placeholderDepth > 0) {
                    notifyError(parser.pos,
                        'INVALID_STRING',
                        'EOF reached while parsing string expression found inside placeholder');
                    return;
                }
                notifyError(parser.pos,
                    'INVALID_STRING',
                    'EOF reached while parsing string expression');
            },

            char(ch, code) {
                var stringParts = currentPart.stringParts;

                var nextCh;
                var quoteCharCode = currentPart.quoteCharCode;

                if (code === CODE_BACK_SLASH) {
                    if (checkForEscapedEscapedPlaceholder(ch, code)) {
                        if (ignorePlaceholders) {
                            // We are actually adding two escaped backslashes here...
                            currentPart.currentText += '\\\\\\\\';
                        } else {
                            currentPart.currentText += '\\';
                        }
                    }  else if (checkForEscapedPlaceholder(ch, code)) {
                        if (ignorePlaceholders) {
                            // We are actually adding one escaped backslashes here...
                            currentPart.currentText += '\\\\$';
                        } else {
                            currentPart.currentText += '$';
                        }
                    } else {
                        // Handle string escape sequence
                        nextCh = parser.lookAtCharAhead(1);
                        currentPart.currentText += ch + nextCh;
                    }

                    parser.skip(1);
                } else if (code === quoteCharCode) {
                    // We encountered the end delimiter
                    if (currentPart.currentText) {
                        stringParts.push(currentPart.currentText);
                    }

                    let stringExpr = '';
                    let quoteChar =  currentPart.quoteChar;

                    if (stringParts.length) {
                        for (let i=0; i<stringParts.length; i++) {
                            let part = stringParts[i];
                            if (i !== 0) {
                                stringExpr += '+';
                            }

                            if (typeof part === 'string') {
                                stringExpr += quoteChar + part + quoteChar;
                            } else {
                                stringExpr += '(' + part.value + ')';
                            }
                        }
                    } else {
                        // Just an empty string...
                        stringExpr = quoteChar + quoteChar;
                    }

                    if (stringParts.length > 1) {
                        stringExpr = '(' + stringExpr + ')';
                    }

                    currentPart.value = stringExpr;
                    endString();
                } else if (!ignorePlaceholders && checkForPlaceholder(ch, code)) {
                    if (currentPart.currentText) {
                        stringParts.push(currentPart.currentText);
                    }

                    currentPart.currentText = '';
                    // We encountered nested placeholder...
                    currentPart.isStringLiteral = false;
                } else {
                    currentPart.currentText += ch;
                }
            }
        });

        var STATE_TEMPLATE_STRING = Parser.createState({
            name: 'STATE_TEMPLATE_STRING',

            placeholder: function(placeholder) {
                if (currentPart.currentText) {
                    currentPart.stringParts.push(currentPart.currentText);
                    currentPart.currentText = '';
                }
                currentPart.isStringLiteral = false;
                currentPart.stringParts.push(placeholder);
            },

            eol(str) {
                // Convert the EOL sequence ot the equivalent string escape sequences... Not necessary
                // for template strings but it is equivalent.
                if (str.length === 2) {
                    currentPart.value += '\\r\\n';
                } else {
                    currentPart.value += '\\n';
                }
            },

            eof() {
                notifyError(parser.pos,
                    'INVALID_TEMPLATE_STRING',
                    'EOF reached while parsing template string expression');
            },

            char(ch, code) {
                var nextCh;
                currentPart.value += ch;
                if (code === CODE_BACK_SLASH) {
                    // Handle string escape sequence
                    nextCh = parser.lookAtCharAhead(1);
                    parser.skip(1);

                    currentPart.value += nextCh;
                } else if (code === CODE_BACKTICK) {
                    endTemplateString();
                }
            }
        });

        // We enter STATE_JS_COMMENT_BLOCK after we encounter a "/*" sequence
        // while in STATE_ATTRIBUTE_VALUE or STATE_DELIMITED_EXPRESSION.
        // We leave STATE_JS_COMMENT_BLOCK when we see a "*/" sequence.
        var STATE_JS_COMMENT_BLOCK = Parser.createState({
            name: 'STATE_JS_COMMENT_BLOCK',

            eol(str) {
                currentPart.value += str;
            },

            eof() {
                notifyError(currentPart.pos,
                    'MALFORMED_COMMENT',
                    'EOF reached while parsing multi-line JavaScript comment');
            },

            char(ch, code) {


                if (code === CODE_ASTERISK) {
                    var nextCode = parser.lookAtCharCodeAhead(1);
                    if (nextCode === CODE_FORWARD_SLASH) {
                        currentPart.endPos = parser.pos + 2;
                        endJavaScriptComment();
                        parser.skip(1);
                        return;
                    }
                }

                currentPart.value += ch;
            }
        });

        // We enter STATE_JS_COMMENT_LINE after we encounter a "//" sequence
        // when parsing JavaScript code.
        // We leave STATE_JS_COMMENT_LINE when we see a newline character.
        var STATE_JS_COMMENT_LINE = Parser.createState({
            name: 'STATE_JS_COMMENT_LINE',

            eol(str) {
                currentPart.value += str;
                currentPart.endPos = parser.pos;
                endJavaScriptComment();
            },

            eof() {
                currentPart.endPos = parser.pos;
                endJavaScriptComment();
            },

            char(ch, code) {
                currentPart.value += ch;
            }
        });

        // We enter STATE_DTD after we encounter a "<!" while in the STATE_HTML_CONTENT.
        // We leave STATE_DTD if we see a ">".
        var STATE_DTD = Parser.createState({
            name: 'STATE_DTD',

            eol(str) {
                currentPart.value += str;
            },

            eof() {
                notifyError(currentPart.pos,
                    'MALFORMED_DOCUMENT_TYPE',
                    'EOF reached while parsing document type');
            },

            char(ch, code) {
                if (code === CODE_CLOSE_ANGLE_BRACKET) {
                    currentPart.endPos = parser.pos + 1;
                    endDocumentType();
                } else {
                    currentPart.value += ch;
                }
            }
        });

        // We enter STATE_DECLARATION after we encounter a "<?"
        // while in the STATE_HTML_CONTENT.
        // We leave STATE_DECLARATION if we see a "?>" or ">".
        var STATE_DECLARATION = Parser.createState({
            name: 'STATE_DECLARATION',

            eol(str) {
                currentPart.value += str;
            },

            eof() {
                notifyError(currentPart.pos,
                    'MALFORMED_DECLARATION',
                    'EOF reached while parsing declaration');
            },

            char(ch, code) {
                if (code === CODE_QUESTION) {
                    var nextCode = parser.lookAtCharCodeAhead(1);
                    if (nextCode === CODE_CLOSE_ANGLE_BRACKET) {
                        currentPart.endPos = parser.pos + 2;
                        endDeclaration();
                        parser.skip(1);
                    }
                } else if (code === CODE_CLOSE_ANGLE_BRACKET) {
                    currentPart.endPos = parser.pos + 1;
                    endDeclaration();
                } else {
                    currentPart.value += ch;
                }
            }
        });

        // We enter STATE_HTML_COMMENT after we encounter a "<--"
        // while in the STATE_HTML_CONTENT.
        // We leave STATE_HTML_COMMENT when we see a "-->".
        var STATE_HTML_COMMENT = Parser.createState({
            name: 'STATE_HTML_COMMENT',

            eol(newLineChars) {
                currentPart.value += newLineChars;
            },

            eof() {
                notifyError(currentPart.pos,
                    'MALFORMED_COMMENT',
                    'EOF reached while parsing comment');
            },

            char(ch, code) {
                if (code === CODE_HYPHEN) {
                    var match = parser.lookAheadFor('->');
                    if (match) {
                        currentPart.endPos = parser.pos + 3;
                        endHtmlComment();
                        parser.skip(match.length);
                    } else {
                        currentPart.value += ch;
                    }
                } else {
                    currentPart.value += ch;
                }
            }
        });

        // We enter STATE_SCRIPTLET after we encounter a "<%" while in STATE_HTML_CONTENT.
        // We leave STATE_SCRIPTLET if we see a "%>".
        var STATE_SCRIPTLET = Parser.createState({
            name: 'STATE_SCRIPTLET',

            eol(str) {
                currentPart.value += str;
            },

            eof() {
                notifyError(currentPart.pos,
                    'MALFORMED_SCRIPTLET',
                    'EOF reached while parsing scriptlet');
            },

            comment(comment) {
                currentPart.value += comment.rawValue;
            },

            char(ch, code) {
                if (currentPart.quoteCharCode) {
                    currentPart.value += ch;

                    // We are within a string... only look for ending string code
                    if (code === CODE_BACK_SLASH) {
                        // Handle string escape sequence
                        currentPart.value += parser.lookAtCharAhead(1);
                        parser.skip(1);
                    } else if (code === currentPart.quoteCharCode) {
                        currentPart.quoteCharCode = null;
                    }
                    return;
                } else if (code === CODE_FORWARD_SLASH) {
                    if (parser.lookAtCharCodeAhead(1) === CODE_ASTERISK) {
                        // Skip over code inside a JavaScript block comment
                        beginBlockComment();
                        parser.skip(1);
                        return;
                    }
                } else if (code === CODE_SINGLE_QUOTE || code === CODE_DOUBLE_QUOTE) {
                    currentPart.quoteCharCode = code;
                } else if (code === CODE_PERCENT) {
                    if (parser.lookAtCharCodeAhead(1) === CODE_CLOSE_ANGLE_BRACKET) {
                        endScriptlet(parser.pos + 2 /* end pos */);
                        parser.skip(1); // Skip over the closing right angle bracket
                        return;
                    }
                }

                currentPart.value += ch;
            }
        });

        parser.enterHtmlContentState = function() {
            if (parser.state !== STATE_HTML_CONTENT) {
                parser.enterState(STATE_HTML_CONTENT);
            }
        };

        parser.enterConciseHtmlContentState = function() {
            if (parser.state !== STATE_CONCISE_HTML_CONTENT) {
                parser.enterState(STATE_CONCISE_HTML_CONTENT);
            }
        };

        parser.enterParsedTextContentState = function() {
            var last = blockStack.length && blockStack[blockStack.length - 1];

            if (!last || !last.tagName) {
                throw new Error('The "parsed text content" parser state is only allowed within a tag');
            }

            if (isConcise) {
                // We will transition into the STATE_PARSED_TEXT_CONTENT state
                // for each of the nested HTML blocks
                last.body = BODY_PARSED_TEXT;
                parser.enterState(STATE_CONCISE_HTML_CONTENT);
            } else {
                parser.enterState(STATE_PARSED_TEXT_CONTENT);
            }
        };

        parser.enterJsContentState = parser.enterParsedTextContentState;
        parser.enterCssContentState = parser.enterParsedTextContentState;

        parser.enterStaticTextContentState = function() {
            var last = blockStack.length && blockStack[blockStack.length - 1];

            if (!last || !last.tagName) {
                throw new Error('The "static text content" parser state is only allowed within a tag');
            }

            if (isConcise) {
                // We will transition into the STATE_STATIC_TEXT_CONTENT state
                // for each of the nested HTML blocks
                last.body = BODY_STATIC_TEXT;
                parser.enterState(STATE_CONCISE_HTML_CONTENT);
            } else {
                parser.enterState(STATE_STATIC_TEXT_CONTENT);
            }
        };


        if (defaultMode === MODE_CONCISE) {
            parser.setInitialState(STATE_CONCISE_HTML_CONTENT);
            parser.enterDefaultState = function() {
                parser.enterState(STATE_CONCISE_HTML_CONTENT);
            };
        } else {
            parser.setInitialState(STATE_HTML_CONTENT);
            parser.enterDefaultState = function() {
                parser.enterState(STATE_HTML_CONTENT);
            };
        }
    }

    parse(data) {
        super.parse(data);
        this.notifiers.notifyFinish();
    }
}

module.exports = Parser;
});
$rmod.def("/htmljs-parser@1.5.13/index", function(require, exports, module, __filename, __dirname) { var Parser = require('./Parser');

exports.createParser = function(listeners, options) {
    var parser = new Parser(listeners, options);
    return parser;
};
});
$rmod.def("/marko@3.3.0/compiler/HtmlJsParser", function(require, exports, module, __filename, __dirname) { 'use strict';
var htmljs = require('/$/htmljs-parser'/*'htmljs-parser'*/);

class HtmlJsParser {
    constructor(options) {
        this.ignorePlaceholders = options && options.ignorePlaceholders === true;
    }

    parse(src, handlers) {
        var listeners = {
            onText(event) {
                handlers.handleCharacters(event.value);
            },

            onPlaceholder(event) {
                if (event.withinBody) {
                    if (!event.withinString) {
                        handlers.handleBodyTextPlaceholder(event.value, event.escape);
                    }
                } else if (event.withinOpenTag) {
                    // Don't escape placeholder for dynamic attributes. For example: <div ${data.myAttrs}></div>
                } else {
                    // placeholder within attribute
                    if (event.escape) {
                        event.value = '$escapeXml(' + event.value + ')';
                    } else {
                        event.value = '$noEscapeXml(' + event.value + ')';
                    }
                }
                // placeholder within content

            },

            onCDATA(event) {
                handlers.handleCharacters(event.value);
            },

            onOpenTag(event, parser) {
                event.selfClosed = false; // Don't allow self-closed tags
                handlers.handleStartElement(event);

                var newParserState = handlers.getParserStateForTag(event);
                if (newParserState) {
                    if (newParserState === 'parsed-text') {
                        parser.enterParsedTextContentState();
                    } else if (newParserState === 'static-text') {
                        parser.enterStaticTextContentState();
                    }
                }
            },

            onCloseTag(event) {
                var tagName = event.tagName;
                handlers.handleEndElement(tagName);
            },

            onDocumentType(event) {

                // Document type: <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd
                // NOTE: The value will be all of the text between "<!" and ">""
                handlers.handleDocumentType(event.value);
            },

            onDeclaration(event) {
                handlers.handleDeclaration(event.value);
            },

            onComment(event) {
                // Text within XML comment
                handlers.handleComment(event.value);
            },

            onScriptlet(event) {
                // <% (code) %>
                handlers.handleScriptlet(event.value);
            },

            onError(event) {
                handlers.handleError(event);
            }
        };

        var parser = this.parser = htmljs.createParser(listeners, {
            ignorePlaceholders: this.ignorePlaceholders,
            isOpenTagOnly: function(tagName) {
                return handlers.isOpenTagOnly(tagName);
            }
        });
        parser.parse(src);
    }
}

module.exports = HtmlJsParser;
});
$rmod.def("/marko@3.3.0/compiler/ast/Program", function(require, exports, module, __filename, __dirname) { 'use strict';
var Node = require('./Node');

class Program extends Node {
    constructor(def) {
        super('Program');
        this.body = def.body;
    }

    generateCode(codegen) {
        var body = this.body;
        codegen.generateStatements(body);
        if (codegen._bufferedWrites) {
            codegen._write('\n');
            codegen._flushBufferedWrites();
        }
    }

    walk(walker) {
        this.body = walker.walk(this.body);
    }
}

module.exports = Program;
});
$rmod.def("/marko@3.3.0/compiler/ast/TemplateRoot", function(require, exports, module, __filename, __dirname) { 'use strict';
var Node = require('./Node');

function createVarsArray(vars) {
    return Object.keys(vars).map(function(varName) {
        var varInit = vars[varName];
        return {
            id: varName,
            init: varInit
        };
    });
}

class TemplateRoot extends Node {
    constructor(def) {
        super('TemplateRoot');
        this.body = this.makeContainer(def.body);
    }

    generateCode(codegen) {
        var context = codegen.context;

        var body = this.body;
        codegen.addStaticVar('str', '__helpers.s');
        codegen.addStaticVar('empty', '__helpers.e');
        codegen.addStaticVar('notEmpty', '__helpers.ne');
        codegen.addStaticVar('escapeXml', '__helpers.x');

        var builder = codegen.builder;
        var program = builder.program;
        var functionDeclaration = builder.functionDeclaration;

        var returnStatement = builder.returnStatement;
        var slot = builder.slot;

        var staticsSlot = slot();
        var varsSlot = slot();
        varsSlot.noOutput = true;

        body = [ varsSlot ].concat(body.items);

        var outputNode = program([
            functionDeclaration('create', ['__helpers'], [
                staticsSlot,

                returnStatement(
                    functionDeclaration('render', ['data', 'out'], body))
            ]),
            '(module.exports = require("marko").c(__filename)).c(create)'
        ]);

        codegen.generateCode(outputNode);

        var staticVars = context.getStaticVars();
        var staticCodeArray = context.getStaticCode();

        var staticContent = [builder.vars(createVarsArray(staticVars))];
        if (staticCodeArray) {
            staticCodeArray.forEach((code) => {
                staticContent.push(code);
            });
        }

        staticsSlot.setContent(staticContent);

        var vars = context.getVars();
        varsSlot.setContent(builder.vars(createVarsArray(vars)));
    }

    toJSON(prettyPrinter) {
        return {
            type: this.type,
            body: this.body
        };
    }

    walk(walker) {
        this.body = walker.walk(this.body);
    }
}

module.exports = TemplateRoot;
});
$rmod.def("/marko@3.3.0/compiler/ast/FunctionDeclaration", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var ok = require('/$/assert'/*'assert'*/).ok;

class FunctionDeclaration extends Node {
    constructor(def) {
        super('FunctionDeclaration');
        this.name = def.name;
        this.params = def.params;
        this.body = this.makeContainer(def.body);
    }

    generateCode(codegen) {
        var name = this.name;
        var params = this.params;
        var body = this.body;
        var statement = this.statement;

        if (name != null) {
            ok(typeof name === 'string' || name.type === 'Identifier', 'Function name should be a string or Identifier');
        }

        if (name) {
            codegen.write('function ');
            codegen.generateCode(name);
            codegen.write('(');
        } else {
            codegen.write('function(');
        }

        if (params && params.length) {
            for (let i=0, paramsLen = params.length; i<paramsLen; i++) {
                if (i !== 0) {
                    codegen.write(', ');
                }
                var param = params[i];

                if (typeof param === 'string') {
                    codegen.write(param);
                } else {
                    if (param.type !== 'Identifier') {
                        throw new Error('Illegal param ' + JSON.stringify(param) + ' for FunctionDeclaration: ' + JSON.stringify(this));
                    }
                    codegen.generateCode(param);
                }
            }
        }

        codegen.write(') ');
        var oldInFunction = codegen.inFunction;
        codegen.inFunction = true;
        codegen.generateBlock(body);
        codegen.inFunction = oldInFunction;

        if (statement) {
            codegen.write('\n');
        }
    }

    isCompoundExpression() {
        return true;
    }

    walk(walker) {
        this.name = walker.walk(this.name);
        this.params = walker.walk(this.params);
        this.body = walker.walk(this.body);
    }
}

module.exports = FunctionDeclaration;
});
$rmod.def("/marko@3.3.0/compiler/ast/FunctionCall", function(require, exports, module, __filename, __dirname) { 'use strict';
var ok = require('/$/assert'/*'assert'*/).ok;

var Node = require('./Node');

class FunctionCall extends Node {
    constructor(def) {
        super('FunctionCall');
        this.callee = def.callee;

        ok(this.callee, '"callee" is required');

        let args = this.args = def.args;

        if (args) {
            if (!Array.isArray(args)) {
                throw new Error('Invalid args');
            }

            for (let i=0; i<args.length; i++) {
                let arg = args[i];
                if (!arg) {
                    throw new Error('Arg ' + i + ' is not valid for function call: ' + JSON.stringify(this.toJSON(), null, 2));
                }
            }
        }
    }

    generateCode(codegen) {
        var callee = this.callee;
        var args = this.args;

        codegen.generateCode(callee);

        codegen.write('(');

        if (args && args.length) {
            for (let i=0, argsLen = args.length; i<argsLen; i++) {
                if (i !== 0) {
                    codegen.write(', ');
                }

                let arg = args[i];
                if (!arg) {
                    throw new Error('Arg ' + i + ' is not valid for function call: ' + JSON.stringify(this.toJSON()));
                }
                codegen.generateCode(arg);
            }
        }

        codegen.write(')');
    }

    walk(walker) {
        this.callee = walker.walk(this.callee);
        this.args = walker.walk(this.args);
    }

    toString() {
        var callee = this.callee;
        var args = this.args;

        var result = callee.toString() + '(';

        if (args && args.length) {
            for (let i=0, argsLen = args.length; i<argsLen; i++) {
                if (i !== 0) {
                    result += ', ';
                }

                let arg = args[i];
                if (!arg) {
                    throw new Error('Arg ' + i + ' is not valid for function call: ' + JSON.stringify(this.toJSON()));
                }
                result += arg;
            }
        }

        result += ')';
        return result;
    }
}

module.exports = FunctionCall;
});
$rmod.def("/marko@3.3.0/compiler/ast/If", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

function removeWhitespaceNodes(whitespaceNodes) {
    for (var i=0; i<whitespaceNodes.length; i++) {
        whitespaceNodes[i].detach();
    }
    whitespaceNodes.length = 0;
}

class If extends Node {
    constructor(def) {
        super('If');
        this.test = def.test;
        this.body = this.makeContainer(def.body);
        this.else = def.else;
    }

    generateCode(codegen) {

        if (this.else) {
            this.else.matched = true;
        } else {
            // We want to match up any else/else if statements
            // with this node so that we can generate the code
            // correctly.
            let previous = this;
            let whitespaceNodes = [];
            this.forEachNextSibling((curNode) => {
                if (curNode.type === 'Else') {
                    curNode.detach();
                    if (whitespaceNodes.length) {
                        removeWhitespaceNodes(whitespaceNodes);
                    }
                    previous.else = curNode;
                    curNode.matched = true;
                    return false; // Stop searching
                } else if (curNode.type === 'ElseIf') {
                    curNode.detach();
                    if (whitespaceNodes.length) {
                        removeWhitespaceNodes(whitespaceNodes);
                    }

                    previous.else = curNode;
                    previous = curNode;
                    curNode.matched = true;
                    return true; // Keep searching since they may be more ElseIf/Else nodes...
                } else if (curNode.type === 'Text') {
                    if (curNode.isWhitespace()) {
                        whitespaceNodes.push(curNode);
                        return true; // Just whitespace... keep searching
                    } else {
                        return false; // Stop searching
                    }
                } else {
                    return false; // Stop searching
                }
            });
        }

        var test = this.test;
        var body = this.body;

        codegen.write('if (');
        codegen.generateCode(test);
        codegen.write(') ');
        codegen.generateBlock(body);
        if (this.else) {
            codegen.write(' ');
            codegen.generateCode(this.else);
        } else {
            codegen.write('\n');
        }
    }

    appendChild(newChild) {
        this.body.appendChild(newChild);
    }

    walk(walker) {
        this.test = walker.walk(this.test);
        this.body = walker.walk(this.body);
        this.else = walker.walk(this.else);
    }
}

module.exports = If;
});
$rmod.def("/marko@3.3.0/compiler/ast/ElseIf", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class ElseIf extends Node {
    constructor(def) {
        super('ElseIf');
        this.test = def.test;
        this.body = this.makeContainer(def.body);
        this.else = def.else;
        this.matched = false;
    }

    generateCode(codegen) {
        if (!this.matched) {
            codegen.addError('Unmatched else statement');
            return;
        }

        var ifStatement = codegen.builder.ifStatement(this.test, this.body, this.else);
        codegen.write('else ');
        codegen.generateCode(ifStatement);
    }

    walk(walker) {
        this.test = walker.walk(this.test);
        this.body = walker.walk(this.body);
        this.else = walker.walk(this.else);
    }
}

module.exports = ElseIf;
});
$rmod.def("/marko@3.3.0/compiler/ast/Else", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class Else extends Node {
    constructor(def) {
        super('Else');
        this.body = this.makeContainer(def.body);
        this.matched = false;
    }

    generateCode(codegen) {
        if (!this.matched) {
            codegen.addError('Unmatched else statement');
            return;
        }
        var body = this.body;

        codegen.write('else ');
        codegen.generateBlock(body);
        codegen.write('\n');
    }

    walk(walker) {
        this.body = walker.walk(this.body);
    }
}

module.exports = Else;
});
$rmod.def("/marko@3.3.0/compiler/ast/Assignment", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class Assignment extends Node {
    constructor(def) {
        super('Assignment');
        this.left = def.left;
        this.right = def.right;
        this.operator = def.operator;
    }

    generateCode(codegen) {
        var left = this.left;
        var right = this.right;
        var operator = this.operator;

        codegen.generateCode(left);
        codegen.write(' '  + (operator || '=') + ' ');

        var wrap = right instanceof Assignment;

        if (wrap) {
            codegen.write('(');
        }

        codegen.generateCode(right);

        if (wrap) {
            codegen.write(')');
        }
    }

    walk(walker) {
        this.left = walker.walk(this.left);
        this.right = walker.walk(this.right);
    }

    isCompoundExpression() {
        return true;
    }

    /**
     * "noOutput" should be true if the Node.js does not result in any HTML or Text output
     */
    get noOutput() {
        return !(this.body && this.body.length);
    }

    toString() {
        var left = this.left;
        var right = this.right;
        var operator = this.operator;

        var result = left.toString() + ' ' + (operator || '=') + ' ';

        var wrap = right instanceof Assignment;

        if (wrap) {
            result += '(';
        }

        result += right.toString();

        if (wrap) {
            result += ')';
        }

        return result;
    }
}

module.exports = Assignment;
});
$rmod.def("/marko@3.3.0/compiler/util/isCompoundExpression", function(require, exports, module, __filename, __dirname) { function isCompoundExpression(expression) {
    if (typeof expression === 'string') {
        // TBD: Should we use Esprima to parse the expression string to see if it is a compount expression?
        return true;
    }

    return expression.isCompoundExpression();
}

module.exports = isCompoundExpression;
});
$rmod.def("/marko@3.3.0/compiler/ast/BinaryExpression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var isCompoundExpression = require('../util/isCompoundExpression');

function generateCodeForOperand(node, codegen) {
    var wrap = isCompoundExpression(node);

    if (wrap) {
        codegen.write('(');
    }

    codegen.generateCode(node);

    if (wrap) {
        codegen.write(')');
    }
}

function operandToString(node) {
    var wrap = isCompoundExpression(node);

    var result = '';

    if (wrap) {
        result += '(';
    }

    result += node.toString();

    if (wrap) {
        result += ')';
    }

    return result;
}

class BinaryExpression extends Node {
    constructor(def) {
        super('BinaryExpression');
        this.left = def.left;
        this.operator = def.operator;
        this.right = def.right;
    }

    generateCode(codegen) {
        var left = this.left;
        var operator = this.operator;
        var right = this.right;

        if (!left || !right) {
            throw new Error('Invalid BinaryExpression: ' + this);
        }

        if (left.type === 'Literal' && right.type === 'Literal') {
            if (operator === '+') {
                return codegen.generateCode(codegen.builder.literal(left.value + right.value));
            } else if (operator === '-') {
                return codegen.generateCode(codegen.builder.literal(left.value - right.value));
            } else if (operator === '*') {
                return codegen.generateCode(codegen.builder.literal(left.value * right.value));
            } else if (operator === '/') {
                return codegen.generateCode(codegen.builder.literal(left.value / right.value));
            }
        }

        generateCodeForOperand(left, codegen);
        codegen.write(' ');
        codegen.generateCode(operator);
        codegen.write(' ');
        generateCodeForOperand(right, codegen);
    }

    isCompoundExpression() {
        return true;
    }

    toJSON() {
        return {
            type: 'BinaryExpression',
            left: this.left,
            operator: this.operator,
            right: this.right
        };
    }

    walk(walker) {
        this.left = walker.walk(this.left);
        this.right = walker.walk(this.right);
    }

    toString() {
        var left = this.left;
        var operator = this.operator;
        var right = this.right;

        if (!left || !right) {
            throw new Error('Invalid BinaryExpression: ' + this);
        }

        return operandToString(left) + ' ' + operator + ' ' + operandToString(right);
    }
}

module.exports = BinaryExpression;
});
$rmod.def("/marko@3.3.0/compiler/ast/LogicalExpression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var isCompoundExpression = require('../util/isCompoundExpression');

function generateCodeForOperand(node, codegen) {
    var wrap = isCompoundExpression(node);

    if (wrap) {
        codegen.write('(');
    }

    codegen.generateCode(node);

    if (wrap) {
        codegen.write(')');
    }
}

function operandToString(node, codegen) {
    var wrap = isCompoundExpression(node);

    var result = '';

    if (wrap) {
        result += '(';
    }

    result += node;

    if (wrap) {
        result += ')';
    }

    return result;
}

class LogicalExpression extends Node {
    constructor(def) {
        super('LogicalExpression');
        this.left = def.left;
        this.operator = def.operator;
        this.right = def.right;
    }

    generateCode(codegen) {
        var left = this.left;
        var operator = this.operator;
        var right = this.right;

        if (!left || !right) {
            throw new Error('Invalid LogicalExpression: ' + this);
        }

        generateCodeForOperand(left, codegen);
        codegen.write(' ');
        codegen.generateCode(operator);
        codegen.write(' ');
        generateCodeForOperand(right, codegen);
    }

    isCompoundExpression() {
        return true;
    }

    toJSON() {
        return {
            type: 'LogicalExpression',
            left: this.left,
            operator: this.operator,
            right: this.right
        };
    }

    walk(walker) {
        this.left = walker.walk(this.left);
        this.right = walker.walk(this.right);
    }

    toString() {
        var left = this.left;
        var operator = this.operator;
        var right = this.right;

        if (!left || !right) {
            throw new Error('Invalid LogicalExpression: ' + this);
        }

        return operandToString(left) + ' ' + operator + ' ' + operandToString(right);
    }
}

module.exports = LogicalExpression;
});
$rmod.def("/marko@3.3.0/compiler/ast/Vars", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class Vars extends Node {
    constructor(def) {
        super('Vars');
        this.kind = def.kind || 'var';
        this.declarations = def.declarations;
        this.body = this.makeContainer(def.body);
    }

    generateCode(codegen) {
        var declarations = this.declarations;
        var kind = this.kind;
        var isStatement = this.statement;
        var body = this.body;

        var hasBody = this.body && this.body.length;

        if(hasBody) {

            var scopedBody = [this].concat(this.body.items);
            this.body = null;

            return codegen.builder.selfInvokingFunction(scopedBody);
        }

        if (!declarations || !declarations.length) {
            return;
        }

        codegen.incIndent(4);

        for (let i=0; i<declarations.length; i++) {
            var declarator = declarations[i];

            if (i === 0) {
                codegen.write(kind + ' ');
            } else {
                codegen.writeLineIndent();
            }

            codegen.generateCode(declarator);

            if (i < declarations.length - 1) {
                codegen.write(',\n');
            } else {
                if (isStatement) {
                    codegen.write(';\n');
                }
            }
        }

        codegen.decIndent(4);

        if (hasBody) {
            codegen.generateCode(body);
        }
    }

    walk(walker) {
        this.argument = walker.walk(this.argument);
    }

    /**
     * "noOutput" should be true if the Node.js does not result in any HTML or Text output
     */
    get noOutput() {
        return !(this.body && this.body.length);
    }
}

module.exports = Vars;
});
$rmod.def("/marko@3.3.0/compiler/ast/Return", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class Return extends Node {
    constructor(def) {
        super('Return');
        this.argument = def.argument;
    }

    generateCode(codegen) {
        if (!codegen.inFunction) {
            throw new Error('"return" not allowed outside a function body');
        }

        var argument = this.argument;

        if (argument) {
            codegen.write('return ');
            codegen.generateCode(argument);
        } else {
            codegen.write('return');
        }
    }

    walk(walker) {
        this.argument = walker.walk(this.argument);
    }
}

module.exports = Return;
});
$rmod.def("/marko@3.3.0/compiler/ast/HtmlAttribute", function(require, exports, module, __filename, __dirname) { 'use strict';
var Node = require('./Node');
var Literal = require('./Literal');
var ok = require('/$/assert'/*'assert'*/).ok;
var escapeXmlAttr = require('/$/raptor-util/escapeXml'/*'raptor-util/escapeXml'*/).attr;
var compiler = require('../');

function isStringLiteral(node) {
    return node.type === 'Literal' && typeof node.value === 'string';
}

function isNoEscapeXml(node) {
    return node.type === 'AttributePlaceholder' &&
        node.escape === false;
}

function flattenAttrConcats(node) {
    // return [node];

    function flattenHelper(node) {
        if (node.type === 'BinaryExpression' && node.operator === '+') {
            let left = flattenHelper(node.left);
            let right = flattenHelper(node.right);

            var isString = left.isString || right.isString;

            if (isString) {
                return {
                    isString: true,
                    concats: left.concats.concat(right.concats)
                };
            } else {
                return {
                    isString: false,
                    concats: [node]
                };
            }

        }

        return {
            isString: isStringLiteral(node) || node.type === 'AttributePlaceholder',
            concats: [node]
        };
    }

    var final = flattenHelper(node);
    return final.concats;
}

function generateCodeForExpressionAttr(name, value, escape, codegen) {
    var flattenedConcats = flattenAttrConcats(value);
    var hasLiteral = false;

    for (let i=0; i<flattenedConcats.length; i++) {
        if (flattenedConcats[i].type === 'Literal') {
            hasLiteral = true;
            break;
        }
    }

    if (hasLiteral) {
        codegen.addWriteLiteral(' ' + name + '="');
        for (let i=0; i<flattenedConcats.length; i++) {
            var part = flattenedConcats[i];
            if (isStringLiteral(part)) {
                part.value = escapeXmlAttr(part.value);
            } else if (part.type === 'Literal') {

            } else if (isNoEscapeXml(part)) {
                part = codegen.builder.functionCall(codegen.builder.identifier('str'), [part]);
            } else {
                if (escape !== false) {
                    var escapeXmlAttrVar = codegen.getEscapeXmlAttrVar();
                    part = codegen.builder.functionCall(escapeXmlAttrVar, [part]);
                }
            }
            codegen.addWrite(part);
        }
        codegen.addWriteLiteral('"');
    } else {
        if (name === 'class') {
            // let builder = codegen.builder;
            // let valueWithEscaping = handleEscaping(value);
            let classAttrVar = codegen.addStaticVar('classAttr', '__helpers.ca');
            codegen.addWrite(codegen.builder.functionCall(classAttrVar, [value]));
        } else if (name === 'style') {
            // let builder = codegen.builder;
            // let valueWithEscaping = handleEscaping(value);
            let styleAttrVar = codegen.addStaticVar('styleAttr', '__helpers.sa');
            codegen.addWrite(codegen.builder.functionCall(styleAttrVar, [value]));
        } else {
            // let builder = codegen.builder;
            // let valueWithEscaping = handleEscaping(value);
            let attrVar = codegen.addStaticVar('attr', '__helpers.a');

            if (escape === false || isNoEscapeXml(value)) {
                escape = false;
            }

            let attrArgs = [codegen.builder.literal(name), value];

            if (escape === false) {
                attrArgs.push(codegen.builder.literal(false));
            }
            codegen.addWrite(codegen.builder.functionCall(attrVar, attrArgs));
        }
    }
}


class HtmlAttribute extends Node {
    constructor(def) {
        super('HtmlAttribute');

        ok(def, 'Invalid attribute definition');
        this.type = 'HtmlAttribute';
        this.name = def.name;
        this.value = def.value;
        this.rawValue = def.rawValue;
        this.escape = def.escape;

        if (typeof this.value === 'string') {
            this.value = compiler.builder.parseExpression(this.value);
        }

        if (this.value && !(this.value instanceof Node)) {
            throw new Error('"value" should be a Node instance');
        }

        this.argument = def.argument;

        this.def = def.def; // The attribute definition loaded from the taglib (if any)
    }

    isLiteralValue() {
        return this.value instanceof Literal;
    }

    isLiteralString() {
        return this.isLiteralValue() &&
            typeof this.value.value === 'string';
    }

    isLiteralBoolean() {
        return this.isLiteralValue() &&
            typeof this.value.value === 'boolean';
    }

    generateHtmlCode(codegen) {
        let name = this.name;
        let value = this.value;
        let argument = this.argument;
        let escape = this.escape !== false;

        if (!name) {
            return;
        }

        if (this.isLiteralValue()) {
            var literalValue = value.value;
            if (typeof literalValue === 'boolean' || literalValue === '') {
                if (literalValue === true || literalValue === '') {
                    codegen.addWriteLiteral(' ' + name);
                }
            } else if (literalValue != null) {
                codegen.addWriteLiteral(' ' + name + '="' + escapeXmlAttr(literalValue) + '"');
            }

        } else if (value != null) {
            codegen.isInAttribute = true;
            generateCodeForExpressionAttr(name, value, escape, codegen);
            codegen.isInAttribute = false;
        } else if (argument) {
            codegen.addWriteLiteral(' ' + name + '(');
            codegen.addWriteLiteral(argument);
            codegen.addWriteLiteral(')');
        } else {
            // Attribute with no value is a boolean attribute
            codegen.addWriteLiteral(' ' + name);
        }
    }

    walk(walker) {
        this.value = walker.walk(this.value);
    }

    get literalValue() {
        if (this.isLiteralValue()) {
            return this.value.value;
        } else {
            throw new Error('Attribute value is not a literal value. Actual: ' + JSON.stringify(this.value, null, 2));
        }
    }
}

HtmlAttribute.isHtmlAttribute = function(attr) {
    return (attr instanceof HtmlAttribute);
};

module.exports = HtmlAttribute;
});
$rmod.def("/marko@3.3.0/compiler/ast/HtmlAttributeCollection", function(require, exports, module, __filename, __dirname) { 'use strict';

var ok = require('/$/assert'/*'assert'*/).ok;

var HtmlAttribute = require('./HtmlAttribute');
var Node = require('./Node');

class HtmlAttributeCollection {
    constructor(attributes) {
        this.replaceAttributes(attributes);
    }

    addAttribute(newAttr) {
        if (arguments.length === 2) {
            let name = arguments[0];
            let expression = arguments[1];
            newAttr = new HtmlAttribute(name, expression);
        } else if (!HtmlAttribute.isHtmlAttribute(newAttr)) {
            newAttr = new HtmlAttribute(newAttr);
        }

        var name = newAttr.name;

        if (this.lookup.hasOwnProperty(name)) {
            for (var i=0; i<this.all.length; i++) {
                var curAttr = this.all[i];
                if (curAttr.name === name) {
                    this.all.splice(i, 1);
                    break;
                }
            }
        }

        if (name) {
            this.lookup[name] = newAttr;
        }

        this.all.push(newAttr);
    }

    removeAttribute(name) {
        ok(typeof name === 'string', 'Invalid attribute name');

        if (!this.lookup.hasOwnProperty(name)) {
            return false;
        }

        delete this.lookup[name];

        for (var i=0; i<this.all.length; i++) {
            var curAttr = this.all[i];
            if (curAttr.name === name) {
                this.all.splice(i, 1);
                break;
            }
        }

        return true;
    }

    renameAttribute(oldName, newName) {
        var key = oldName;

        var attr = this.lookup[key];
        if (!attr) {
            return;
        }

        attr.name = newName;
        delete this.lookup[key];
        this.lookup[key] = attr;
    }

    removeAllAttributes() {
        this.replaceAttributes([]);
    }

    hasAttribute(name) {
        ok(typeof name === 'string', 'Invalid attribute name');
        return this.lookup.hasOwnProperty(name);
    }

    hasAttributes() {
        return this.all.length > 0;
    }

    getAttribute(name) {
        return this.lookup[name];
    }

    setAttributeValue(name, value) {
        var attr = this.getAttribute(name);
        if (attr) {
            attr.value = value;
        } else {
            this.addAttribute({
                name: name,
                value: value
            });
        }
    }

    getAttributes() {
        return this.all;
    }

    toJSON() {
        return this.all;
    }

    toString() {
        return JSON.stringify(this.all);
    }

    replaceAttributes(attributes) {
        this.all = [];
        this.lookup = {};

        if (attributes) {
            if (Array.isArray(attributes)) {
                attributes.forEach((attr) => {
                    this.addAttribute(attr);
                });
            } else {
                for (var attrName in attributes) {
                    if (attributes.hasOwnProperty(attrName)) {
                        let attrValue = attributes[attrName];
                        let attrDef;

                        if (attrValue != null && typeof attrValue === 'object' && !(attrValue instanceof Node)) {
                            attrDef = attrValue;
                            attrDef.name = attrName;
                        } else {
                            attrDef = {
                                name: attrName,
                                value: attrValue
                            };
                        }

                        this.addAttribute(attrDef);
                    }
                }
            }
        }
    }

    walk(walker) {
        var newAttributes = walker.walk(this.all);
        this.replaceAttributes(newAttributes);
    }
}

module.exports = HtmlAttributeCollection;
});
$rmod.def("/marko@3.3.0/compiler/ast/HtmlElement", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var Literal = require('./Literal');
var HtmlAttributeCollection = require('./HtmlAttributeCollection');

class StartTag extends Node {
    constructor(def) {
        super('StartTag');

        this.tagName = def.tagName;
        this.attributes = def.attributes;
        this.argument = def.argument;
        this.selfClosed = def.selfClosed;
        this.dynamicAttributes = def.dynamicAttributes;
    }

    generateCode(codegen) {
        var builder = codegen.builder;

        var tagName = this.tagName;
        var selfClosed = this.selfClosed;
        var dynamicAttributes = this.dynamicAttributes;

        // Starting tag
        codegen.addWriteLiteral('<');

        codegen.addWrite(tagName);

        var attributes = this.attributes;

        if (attributes) {
            for (let i=0; i<attributes.length; i++) {
                let attr = attributes[i];
                codegen.generateCode(attr);
            }
        }

        if (dynamicAttributes) {
            dynamicAttributes.forEach(function(attrsExpression) {
                codegen.addStaticVar('attrs', '__helpers.as');
                let attrsFunctionCall = builder.functionCall('attrs', [attrsExpression]);
                codegen.addWrite(attrsFunctionCall);
            });
        }

        if (selfClosed) {
            codegen.addWriteLiteral('/>');
        } else {
            codegen.addWriteLiteral('>');
        }
    }
}

class EndTag extends Node {
    constructor(def) {
        super('EndTag');
        this.tagName = def.tagName;
    }

    generateCode(codegen) {
        var tagName = this.tagName;
        codegen.addWriteLiteral('</');
        codegen.addWrite(tagName);
        codegen.addWriteLiteral('>');
    }
}

class HtmlElement extends Node {
    constructor(def) {
        super('HtmlElement');
        this.tagName = null;
        this.tagNameExpression = null;
        this.setTagName(def.tagName);
        this._attributes = def.attributes;
        this.body = this.makeContainer(def.body);
        this.argument = def.argument;

        if (!(this._attributes instanceof HtmlAttributeCollection)) {
            this._attributes = new HtmlAttributeCollection(this._attributes);
        }

        this.openTagOnly = def.openTagOnly;
        this.selfClosed = def.selfClosed;
        this.dynamicAttributes = undefined;
        this.bodyOnlyIf = undefined;
    }

    generateHtmlCode(codegen) {
        var tagName = this.tagName;

        // Convert the tag name into a Node so that we generate the code correctly
        if (tagName) {
            tagName = codegen.builder.literal(tagName);
        } else {
            tagName = this.tagNameExpression;
        }

        var context = codegen.context;

        if (context.isMacro(this.tagName)) {
            // At code generation time, if this tag corresponds to a registered macro
            // then invoke the macro based on this HTML element instead of generating
            // the code to render an HTML element.
            return codegen.builder.invokeMacroFromEl(this);
        }

        var attributes = this._attributes && this._attributes.all;
        var body = this.body;
        var argument = this.argument;
        var hasBody = body && body.length;
        var openTagOnly = this.openTagOnly;
        var bodyOnlyIf = this.bodyOnlyIf;
        var dynamicAttributes = this.dynamicAttributes;
        var selfClosed = this.selfClosed === true;

        var builder = codegen.builder;

        if (hasBody || bodyOnlyIf) {
            openTagOnly = false;
            selfClosed = false;
        } else if (selfClosed){
            openTagOnly = true;
        }

        var startTag = new StartTag({
            tagName: tagName,
            attributes: attributes,
            argument: argument,
            selfClosed: selfClosed,
            dynamicAttributes: dynamicAttributes
        });

        var endTag;

        if (!openTagOnly) {
            endTag = new EndTag({
                tagName: tagName
            });
        }

        if (bodyOnlyIf) {
            var startIf = builder.ifStatement(builder.negate(bodyOnlyIf), [
                startTag
            ]);

            var endIf = builder.ifStatement(builder.negate(bodyOnlyIf), [
                endTag
            ]);

            return [
                startIf,
                body,
                endIf
            ];
        } else {
            if (openTagOnly) {
                codegen.generateCode(startTag);
            } else {
                return [
                    startTag,
                    body,
                    endTag
                ];
            }
        }
    }

    addDynamicAttributes(expression) {
        if (!this.dynamicAttributes) {
            this.dynamicAttributes = [];
        }

        this.dynamicAttributes.push(expression);
    }

    getAttribute(name) {
        return this._attributes != null && this._attributes.getAttribute(name);
    }

    getAttributeValue(name) {
        var attr = this._attributes != null && this._attributes.getAttribute(name);
        if (attr) {
            return attr.value;
        }
    }

    addAttribute(attr) {
        this._attributes.addAttribute(attr);
    }

    setAttributeValue(name, value) {
        this._attributes.setAttributeValue(name, value);
    }

    replaceAttributes(newAttributes) {
        this._attributes.replaceAttributes(newAttributes);
    }

    removeAttribute(name) {
        if (this._attributes) {
            this._attributes.removeAttribute(name);
        }
    }

    removeAllAttributes() {
        this._attributes.removeAllAttributes();
    }

    hasAttribute(name) {
        return this._attributes != null && this._attributes.hasAttribute(name);
    }

    getAttributes() {
        return this._attributes.all;
    }

    get attributes() {
        return this._attributes.all;
    }

    forEachAttribute(callback, thisObj) {
        var attributes = this._attributes.all.concat([]);

        for (let i=0, len=attributes.length; i<len; i++) {
            callback.call(thisObj, attributes[i]);
        }
    }

    setTagName(tagName) {
        this.tagName = null;
        this.tagNameExpression = null;

        if (tagName instanceof Node) {
            if (tagName instanceof Literal) {
                this.tagName = tagName.value;
                this.tagNameExpression = tagName;
            } else {
                this.tagNameExpression = tagName;
            }
        } else if (typeof tagName === 'string') {
            this.tagNameExpression = new Literal({value: tagName});
            this.tagName = tagName;
        }
    }

    toJSON() {
        return {
            type: this.type,
            tagName: this.tagName,
            attributes: this._attributes,
            argument: this.argument,
            body: this.body,
            bodyOnlyIf: this.bodyOnlyIf,
            dynamicAttributes: this.dynamicAttributes
        };
    }

    setBodyOnlyIf(condition) {
        this.bodyOnlyIf = condition;
    }

    walk(walker) {
        this.setTagName(walker.walk(this.tagNameExpression));
        this._attributes.walk(walker);
        this.body = walker.walk(this.body);
    }
}

module.exports = HtmlElement;
});
$rmod.def("/marko@3.3.0/compiler/ast/Html", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class Html extends Node {
    constructor(def) {
        super('Html');
        this.argument = def.argument;
    }

    isLiteral() {
        return this.argument instanceof Node && this.argument.type === 'Literal';
    }

    generateHtmlCode(codegen) {
        let argument = this.argument;
        codegen.addWrite(argument);
    }

    walk(walker) {
        this.argument = walker.walk(this.argument);
    }
}

module.exports = Html;
});
$rmod.def("/marko@3.3.0/compiler/ast/Text", function(require, exports, module, __filename, __dirname) { 'use strict';

var ok = require('/$/assert'/*'assert'*/).ok;
var Node = require('./Node');
var Literal = require('./Literal');
var escapeXml = require('/$/raptor-util/escapeXml'/*'raptor-util/escapeXml'*/);

class Text extends Node {
    constructor(def) {
        super('Text');
        this.argument = def.argument;
        this.escape = def.escape !== false;
        this.normalized = false;
        this.isFirst = false;
        this.isLast = false;
        this.preserveWhitespace = def.preserveWhitespace === true;

        ok(this.argument, 'Invalid argument');
    }

    isLiteral() {
        return this.argument instanceof Node && this.argument.type === 'Literal';
    }

    generateHtmlCode(codegen) {
        var parentNode = this.parentNode;
        if (parentNode) {
            parentNode._normalizeChildTextNodes(codegen);
        }

        var argument = this.argument;
        var escape = this.escape !== false;

        if (argument instanceof Literal) {
            if (!argument.value) {
                return;
            }

            if (escape === true) {
                argument.value = escapeXml(argument.value.toString());
            }
        } else {
            let builder = codegen.builder;

            if (escape) {
                // TODO Only escape the parts that need to be escaped if it is a compound expression with static
                //      text parts
                argument = builder.functionCall(
                    'escapeXml',
                    [argument]);
            } else {
                argument = builder.functionCall(builder.identifier('str'), [ argument ]);
            }
        }

        codegen.addWrite(argument);
    }

    isWhitespace() {
        var argument = this.argument;
        return (argument instanceof Literal) &&
            (typeof argument.value === 'string') &&
            (argument.value.trim() === '');
    }

    appendText(text) {
        if (!this.isLiteral()) {
            throw new Error('Text cannot be appended to a non-literal Text node');
        }

        this.argument.value += text;
    }

    toJSON() {
        return {
            type: this.type,
            argument: this.argument
        };
    }
}

module.exports = Text;
});
$rmod.def("/marko@3.3.0/compiler/ast/ForEach", function(require, exports, module, __filename, __dirname) { 'use strict';
var ok = require('/$/assert'/*'assert'*/).ok;
var Node = require('./Node');

class ForEach extends Node {
    constructor(def) {
        super('ForEach');
        this.varName = def.varName;
        this.in = def.in;
        this.body = this.makeContainer(def.body);
        this.separator = def.separator;
        this.statusVarName = def.statusVarName;
        this.iterator = def.iterator;

        ok(this.varName, '"varName" is required');
        ok(this.in != null, '"in" is required');
    }

    generateCode(codegen) {
        var varName = this.varName;
        var inExpression = this.in;
        var separator = this.separator;
        var statusVarName = this.statusVarName;
        var iterator = this.iterator;

        var builder = codegen.builder;

        if (separator && !statusVarName) {
            statusVarName = '__loop';
        }

        if (iterator) {
            let params = [varName];

            if (statusVarName) {
                params.push(statusVarName);
            }

            return builder.functionCall(iterator, [
                inExpression,
                builder.functionDeclaration(null, params, this.body)
            ]);
        } else if (statusVarName) {
            let forEachVarName = codegen.addStaticVar('forEachWithStatusVar', '__helpers.fv');
            let body = this.body;

            if (separator) {
                let isNotLastTest = builder.functionCall(
                    builder.memberExpression(statusVarName, builder.identifier('isLast')),
                    []);

                isNotLastTest = builder.negate(isNotLastTest);

                body = body.items.concat([
                    builder.ifStatement(isNotLastTest, [
                        builder.text(separator)
                    ])
                ]);
            }

            return builder.functionCall(forEachVarName, [
                inExpression,
                builder.functionDeclaration(null, [varName, statusVarName], body)
            ]);
        } else {
            let forEachVarName = codegen.addStaticVar('forEach', '__helpers.f');

            return builder.functionCall(forEachVarName, [
                inExpression,
                builder.functionDeclaration(null, [varName], this.body)
            ]);
        }

    }

    walk(walker) {
        this.varName = walker.walk(this.varName);
        this.in = walker.walk(this.in);
        this.body = walker.walk(this.body);
        this.separator = walker.walk(this.separator);
        this.statusVarName = walker.walk(this.statusVarName);
        this.iterator = walker.walk(this.iterator);
    }
}

module.exports = ForEach;
});
$rmod.def("/marko@3.3.0/compiler/ast/ForEachProp", function(require, exports, module, __filename, __dirname) { 'use strict';
var ok = require('/$/assert'/*'assert'*/).ok;
var Node = require('./Node');

class ForEachProp extends Node {
    constructor(def) {
        super('ForEachProp');
        this.nameVarName = def.nameVarName;
        this.valueVarName = def.valueVarName;
        this.in = def.in;
        this.body = this.makeContainer(def.body);

        ok(this.nameVarName, '"nameVarName" is required');
        ok(this.valueVarName != null, '"valueVarName" is required');
        ok(this.in != null, '"in" is required');
    }

    generateCode(codegen) {
        var nameVarName = this.nameVarName;
        var valueVarName = this.valueVarName;
        var inExpression = this.in;
        var body = this.body;

        var builder = codegen.builder;

        let forEachVarName = codegen.addStaticVar('forEachProp', '__helpers.fp');

        return builder.functionCall(forEachVarName, [
            inExpression,
            builder.functionDeclaration(null, [nameVarName, valueVarName], body)
        ]);

    }

    walk(walker) {
        this.nameVarName = walker.walk(this.nameVarName);
        this.valueVarName = walker.walk(this.valueVarName);
        this.in = walker.walk(this.in);
        this.body = walker.walk(this.body);
    }
}

module.exports = ForEachProp;
});
$rmod.def("/marko@3.3.0/compiler/ast/ForRange", function(require, exports, module, __filename, __dirname) { 'use strict';
var ok = require('/$/assert'/*'assert'*/).ok;
var Node = require('./Node');
var Literal = require('./Literal');
var Identifier = require('./Identifier');

class ForRange extends Node {
    constructor(def) {
        super('ForRange');
        this.varName = def.varName;
        this.body = this.makeContainer(def.body);
        this.from = def.from;
        this.to = def.to;
        this.step = def.step;

        ok(this.varName, '"varName" is required');
        ok(this.from != null, '"from" is required');
    }

    generateCode(codegen) {
        var varName = this.varName;
        var from = this.from;
        var to = this.to;
        var step = this.step;

        var builder = codegen.builder;

        var comparison = '<=';

        if (varName instanceof Identifier) {
            varName = varName.name;
        }

        var updateExpression;

        if (step == null) {
            let fromLiteral = (from instanceof Literal) && from.value;
            let toLiteral = (to instanceof Literal) && to.value;

            if (typeof fromLiteral === 'number' && typeof toLiteral === 'number') {
                if (fromLiteral > toLiteral) {
                    updateExpression = varName + '--';
                    comparison = '>=';
                } else {
                    updateExpression = varName + '++';
                }
            }
        } else {
            let stepLiteral;

            if (step instanceof Literal) {
                stepLiteral = step.value;
            } else if (typeof step === 'number') {
                stepLiteral = step;
            }

            if (typeof stepLiteral === 'number') {
                if (stepLiteral < 0) {
                    comparison = '>=';
                }

                if (stepLiteral === 1) {
                    updateExpression = varName + '++';
                } else if (stepLiteral  === -1) {
                    updateExpression = varName + '--';
                } else if (stepLiteral > 0) {
                    updateExpression = varName + ' += ' + stepLiteral;
                } else if (stepLiteral === 0) {
                    throw new Error('Invalid step of 0');
                } else if (stepLiteral < 0) {
                    stepLiteral = 0-stepLiteral; // Make the step positive and switch to -=
                    updateExpression = varName + ' -= ' + stepLiteral;
                }
            } else {
                updateExpression = builder.assignment(varName, step, '+=');
            }
        }

        if (updateExpression == null) {
            updateExpression = varName + '++';
        }

        return builder.selfInvokingFunction([
            builder.forStatement({
                init: [
                    builder.vars([ { id: varName, init: from }])
                ],
                test: builder.binaryExpression(varName, comparison, to),
                update: updateExpression,
                body: this.body
            })
        ]);
    }

    walk(walker) {
        this.varName = walker.walk(this.varName);
        this.body = walker.walk(this.body);
        this.from = walker.walk(this.from);
        this.to = walker.walk(this.to);
        this.step = walker.walk(this.step);
    }
}

module.exports = ForRange;
});
$rmod.def("/marko@3.3.0/compiler/ast/Slot", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class Slot extends Node {
    constructor(def) {
        super('Slot');
        this.onDone = def.onDone;
        this.codegenSlot = null;
    }

    generateCode(codegen) {
        if (this.onDone) {
            codegen.onDone((codegen) => {
                this.onDone(this, codegen);
            });
        }
        // At the time the code for this node is to be generated we instead
        // create a slot. A slot is just a marker in the output code stream
        // that we can later inject code into. The injection happens after
        // the entire tree has been walked.
        this.codegenSlot = codegen.beginSlot(this);
    }

    setContent(content) {
        this.codegenSlot.setContent(content);
    }

    toJSON() {
        return {
            type: this.type
        };
    }
}

module.exports = Slot;
});
$rmod.def("/marko@3.3.0/compiler/ast/HtmlComment", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class HtmlComment extends Node {
    constructor(def) {
        super('HtmlComment');
        this.comment = def.comment;
    }

    generateHtmlCode(codegen) {
        var comment = this.comment;
        var literal = codegen.builder.literal;

        codegen.addWrite(literal('<!--'));
        codegen.addWrite(comment);
        codegen.addWrite(literal('-->'));
    }

    walk(walker) {
        this.comment = walker.walk(this.comment);
    }
}

module.exports = HtmlComment;
});
$rmod.def("/marko@3.3.0/compiler/ast/SelfInvokingFunction", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class SelfInvokingFunction extends Node {
    constructor(def) {
        super('SelfInvokingFunction');
        this.params = def.params;
        this.args = def.args;
        this.body = this.makeContainer(def.body);
    }

    generateCode(codegen) {
        var params = this.params || [];
        var args = this.args || [];
        var body = this.body;

        codegen.write('(');
        var functionDeclaration = codegen.builder.functionDeclaration(null, params, body);
        var functionCall = codegen.builder.functionCall(functionDeclaration, args);
        codegen.generateCode(functionCall);

        codegen.write(')');
    }

    walk(walker) {
        this.params = walker.walk(this.params);
        this.args = walker.walk(this.args);
        this.body = walker.walk(this.body);
    }
}

module.exports = SelfInvokingFunction;
});
$rmod.def("/marko@3.3.0/compiler/ast/ForStatement", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class ForStatement extends Node {
    constructor(def) {
        super('ForStatement');
        this.init = def.init;
        this.test = def.test;
        this.update = def.update;
        this.body = this.makeContainer(def.body);
    }

    generateCode(codegen) {
        var init = this.init;
        var test = this.test;
        var update = this.update;
        var body = this.body;

        codegen.write('for (');

        if (init) {
            codegen.generateCode(init);
        }

        codegen.write('; ');

        if (test) {
            codegen.generateCode(test);
        }

        codegen.write('; ');

        if (update) {
            codegen.generateCode(update);
        }

        codegen.write(') ');

        codegen.generateBlock(body);

        codegen.write('\n');
    }

    walk(walker) {
        this.init = walker.walk(this.init);
        this.test = walker.walk(this.test);
        this.update = walker.walk(this.update);
        this.body = walker.walk(this.body);
    }
}

module.exports = ForStatement;
});
$rmod.def("/marko@3.3.0/compiler/ast/UpdateExpression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var isCompoundExpression = require('../util/isCompoundExpression');

class UpdateExpression extends Node {
    constructor(def) {
        super('UpdateExpression');
        this.argument = def.argument;
        this.operator = def.operator;
        this.prefix = def.prefix === true;
    }

    generateCode(codegen) {
        var argument = this.argument;
        var operator = this.operator;
        var prefix = this.prefix;

        if (prefix) {
            codegen.generateCode(operator);
        }

        var wrap = isCompoundExpression(argument);

        if (wrap) {
            codegen.write('(');
        }

        codegen.generateCode(argument);

        if (wrap) {
            codegen.write(')');
        }

        if (!prefix) {
            codegen.generateCode(operator);
        }
    }

    isCompoundExpression() {
        return true;
    }

    toJSON() {
        return {
            type: 'UpdateExpression',
            argument: this.argument,
            operator: this.operator,
            prefix: this.prefix
        };
    }

    walk(walker) {
        this.argument = walker.walk(this.argument);
    }

    toString() {
        var argument = this.argument;
        var operator = this.operator;
        var prefix = this.prefix;

        let result = '';

        if (prefix) {
            result += operator;
        }

        var wrap = isCompoundExpression(argument);

        if (wrap) {
            result += '(';
        }

        result += argument;

        if (wrap) {
            result += ')';
        }

        if (!prefix) {
            result += operator;
        }

        return result;
    }
}

module.exports = UpdateExpression;
});
$rmod.def("/marko@3.3.0/compiler/ast/UnaryExpression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var isCompoundExpression = require('../util/isCompoundExpression');

class UnaryExpression extends Node {
    constructor(def) {
        super('UnaryExpression');
        this.argument = def.argument;
        this.operator = def.operator;
        this.prefix = def.prefix === true;
    }

    generateCode(codegen) {
        var argument = this.argument;
        var operator = this.operator;
        var prefix = this.prefix;

        if (prefix) {
            codegen.write(operator);

            if (operator === 'typeof' || operator === 'delete') {
                codegen.write(' ');
            }
        }

        var wrap = isCompoundExpression(argument);

        if (wrap) {
            codegen.write('(');
        }

        codegen.generateCode(argument);

        if (wrap) {
            codegen.write(')');
        }

        if (!prefix) {
            codegen.write(operator);
        }
    }

    isCompoundExpression() {
        return true;
    }

    toJSON() {
        return {
            type: 'UnaryExpression',
            argument: this.argument,
            operator: this.operator,
            prefix: this.prefix
        };
    }

    walk(walker) {
        this.argument = walker.walk(this.argument);
    }

    toString() {
        var argument = this.argument;
        var operator = this.operator;
        var prefix = this.prefix;

        let result = '';

        if (prefix) {
            result += operator;

            if (operator === 'typeof' || operator === 'delete') {
                result += ' ';
            }
        }

        var wrap = isCompoundExpression(argument);

        if (wrap) {
            result += '(';
        }

        result += argument;

        if (wrap) {
            result += ')';
        }

        if (!prefix) {
            result += operator;
        }

        return result;
    }
}

module.exports = UnaryExpression;
});
$rmod.def("/marko@3.3.0/compiler/ast/MemberExpression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class MemberExpression extends Node {
    constructor(def) {
        super('MemberExpression');
        this.object = def.object;
        this.property = def.property;
        this.computed = def.computed;
    }

    generateCode(codegen) {
        var object = this.object;
        var property = this.property;
        var computed = this.computed;

        codegen.generateCode(object);

        if (computed) {
            codegen.write('[');
            codegen.generateCode(property);
            codegen.write(']');
        } else {
            codegen.write('.');
            codegen.generateCode(property);
        }
    }

    toJSON() {
        return {
            type: 'MemberExpression',
            object: this.object,
            property: this.property,
            computed: this.computed
        };
    }

    walk(walker) {
        this.object = walker.walk(this.object);
        this.property = walker.walk(this.property);
    }

    toString() {
        var object = this.object;
        var property = this.property;
        var computed = this.computed;

        var result = object.toString();

        if (computed) {
            result += '[' + property + ']';
        } else {
            result += '.' + property;
        }

        return result;
    }
}

module.exports = MemberExpression;
});
$rmod.def("/marko@3.3.0/compiler/util/adjustIndent", function(require, exports, module, __filename, __dirname) { var splitLinesRegExp = /\r?\n/;
var initialIndentationRegExp = /^\s+/;

function removeInitialEmptyLines(lines) {
    var i;

    for (i=0; i<lines.length; i++) {
        if (lines[i].trim() !== '') {
            break;
        }
    }

    if (i !== 0) {
        lines = lines.slice(i);
    }

    return lines;
}

function removeTrailingEmptyLines(lines) {
    var i;
    var last = lines.length-1;

    for (i=last; i>=0; i--) {
        if (lines[i].trim() !== '') {
            break;
        }
    }

    if (i !== last) {
        lines = lines.slice(0, i+1);
    }

    return lines;
}

function adjustIndent(str, newIndentation) {
    if (!str) {
        return str;
    }

    var lines = str.split(splitLinesRegExp);
    lines = removeInitialEmptyLines(lines);
    lines = removeTrailingEmptyLines(lines);

    if (lines.length === 0) {
        return '';
    }

    var initialIndentationMatches = initialIndentationRegExp.exec(lines[0]);

    var indentation = initialIndentationMatches ? initialIndentationMatches[0] : '';
    if (!indentation && !newIndentation) {
        return str;
    }

    lines.forEach((line, i) => {
        if (line.startsWith(indentation)) {
            line = line.substring(indentation.length);
        }

        lines[i] = line;
    });

    return newIndentation ?
        lines.join('\n' + newIndentation) :
        lines.join('\n');
}

module.exports = adjustIndent;
});
$rmod.def("/marko@3.3.0/compiler/ast/Code", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var adjustIndent = require('../util/adjustIndent');

class Code extends Node {
    constructor(def) {
        super('Code');
        this.value = def.value;
    }

    generateCode(codegen) {
        var code = this.value;

        if (!code) {
            return;
        }

        code = adjustIndent(code, codegen.currentIndent);

        codegen.write(code);
    }
}

module.exports = Code;
});
$rmod.def("/marko@3.3.0/compiler/ast/InvokeMacro", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var ok = require('/$/assert'/*'assert'*/).ok;

function removeTrailingUndefineds(args) {
    var i;
    var last = args.length-1;

    for (i=last; i>=0; i--) {
        if (args[i].type !== 'Literal' || args[i].value !== undefined) {
            break;
        }
    }

    if (i !== last) {
        args = args.slice(0, i+1);
    }

    return args;
}


class InvokeMacro extends Node {
    constructor(def) {
        super('InvokeMacro');
        this.el = def.el;
        this.name = def.name;
        this.args = def.args;
        this.body = this.makeContainer(def.body);

        if (this.name != null) {
            ok(typeof this.name === 'string', 'Invalid macro name: ' + this.name);
        }
    }

    generateCode(codegen) {
        var el = this.el;
        var name = this.name;
        var args = this.args;
        var body = this.body;

        var builder = codegen.builder;

        var macroDef;

        if (el) {
            name = el.tagName;
            body = el.body;

            if (typeof name !== 'string') {
                codegen.context.addError(el, 'Element node with a dynamic tag name cannot be used to invoke a macro', 'ERR_INVOKE_MACRO');
                return;
            }

            macroDef = codegen.context.getRegisteredMacro(name);

            if (!macroDef) {
                codegen.context.addError(el, 'Element node does not correspond to a macro', 'ERR_INVOKE_MACRO');
                return;
            }

            if (el.argument) {
                args = builder.parseJavaScriptArgs(el.argument);
            } else {
                args = new Array(macroDef.params.length);
                for (let i=0; i<args.length; i++) {
                    args[i] = builder.literal(undefined);
                }

                el.forEachAttribute((attr) => {
                    var paramName = attr.name;
                    var paramIndex = macroDef.getParamIndex(paramName);
                    if (paramIndex == null) {
                        codegen.context.addError(el, 'The "' + name + '" macro does not have a parameter named "' + paramName + '"', 'ERR_INVOKE_MACRO');
                        return;
                    }

                    var value = attr.value;
                    if (value == null) {
                        value = builder.literal(true);
                    }
                    args[paramIndex] = value;
                });
            }
        } else {
            macroDef = codegen.context.getRegisteredMacro(name);
            if (!macroDef) {
                codegen.addError('Macro not found with name "' + name + '"', 'ERR_INVOKE_MACRO');
                return;
            }
        }

        if (!args) {
            args = [];
        }

        while (args.length < macroDef.params.length) {
            args.push(builder.literal(undefined));
        }

        if (body && body.length) {
            args[macroDef.getParamIndex('renderBody')] = builder.renderBodyFunction(body);
        }

        args[macroDef.getParamIndex('out')] = builder.identifier('out');

        args = removeTrailingUndefineds(args);

        return builder.functionCall(builder.identifier(macroDef.functionName), args);
    }

    walk(walker) {
        this.el = walker.walk(this.el);
        this.name = walker.walk(this.name);
        this.args = walker.walk(this.args);
        this.body = walker.walk(this.body);
    }
}

module.exports = InvokeMacro;
});
$rmod.def("/marko@3.3.0/compiler/ast/Macro", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var ok = require('/$/assert'/*'assert'*/).ok;

class Macro extends Node {
    constructor(def) {
        super('Macro');
        this.name = def.name;
        this.params = def.params;
        this.body = this.makeContainer(def.body);

        if (this.params == null) {
            this.params = [];
        } else {
            ok(Array.isArray(this.params), '"params" should be an array');
        }
    }

    generateCode(codegen) {
        var name = this.name;
        var params = this.params || [];

        var body = this.body;

        var builder = codegen.builder;

        var macroDef = codegen.context.registerMacro(name, params);
        var functionName = macroDef.functionName;
        return builder.functionDeclaration(functionName, macroDef.params, body);
    }

    walk(walker) {
        this.body = walker.walk(this.body);
    }
}

module.exports = Macro;
});
$rmod.def("/marko@3.3.0/compiler/ast/ConditionalExpression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class ConditionalExpression extends Node {
    constructor(def) {
        super('ConditionalExpression');
        this.test = def.test;
        this.consequent = def.consequent;
        this.alternate = def.alternate;
    }

    generateCode(codegen) {
        var test = this.test;
        var consequent = this.consequent;
        var alternate = this.alternate;


        codegen.generateCode(test);
        codegen.write(' ? ');
        codegen.generateCode(consequent);
        codegen.write(' : ');
        codegen.generateCode(alternate);
    }

    isCompoundExpression() {
        return true;
    }

    toJSON() {
        return {
            type: 'ConditionalExpression',
            test: this.test,
            consequent: this.consequent,
            alternate: this.alternate
        };
    }

    walk(walker) {
        this.test = walker.walk(this.test);
        this.consequent = walker.walk(this.consequent);
        this.alternate = walker.walk(this.alternate);
    }

    toString() {
        var test = this.test;
        var consequent = this.consequent;
        var alternate = this.alternate;
        return test.toString() + ' ? ' + consequent + ' : ' + alternate;
    }
}

module.exports = ConditionalExpression;
});
$rmod.def("/marko@3.3.0/compiler/ast/NewExpression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var isCompoundExpression = require('../util/isCompoundExpression');

class NewExpression extends Node {
    constructor(def) {
        super('NewExpression');
        this.callee = def.callee;
        this.args = def.args;
    }

    generateCode(codegen) {
        var callee = this.callee;
        var args = this.args;

        codegen.write('new ');

        var wrap = isCompoundExpression(callee);

        if (wrap) {
            codegen.write('(');
        }

        codegen.generateCode(callee);

        if (wrap) {
            codegen.write(')');
        }

        codegen.write('(');

        if (args && args.length) {
            for (let i=0, argsLen = args.length; i<argsLen; i++) {
                if (i !== 0) {
                    codegen.write(', ');
                }

                let arg = args[i];
                if (!arg) {
                    throw new Error('Arg ' + i + ' is not valid for new expression: ' + JSON.stringify(this.toJSON()));
                }
                codegen.generateCode(arg);
            }
        }

        codegen.write(')');
    }

    isCompoundExpression() {
        return true;
    }

    toJSON() {
        return {
            type: 'NewExpression',
            callee: this.callee,
            args: this.args
        };
    }

    walk(walker) {
        this.callee = walker.walk(this.callee);
        this.args = walker.walk(this.args);
    }

    toString() {
        var callee = this.callee;
        var args = this.args;

        let result = 'new ';

        var wrap = isCompoundExpression(callee);

        if (wrap) {
            result += '(';
        }

        result += callee;

        if (wrap) {
            result += ')';
        }


        result += '(';

        if (args && args.length) {
            for (let i=0, argsLen = args.length; i<argsLen; i++) {
                if (i !== 0) {
                    result += ', ';
                }

                let arg = args[i];
                result += arg;
            }
        }

        result += ')';

        return result;
    }
}

module.exports = NewExpression;
});
$rmod.def("/marko@3.3.0/compiler/ast/ObjectExpression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class ObjectExpression extends Node {
    constructor(def) {
        super('ObjectExpression');
        this.properties = def.properties;
    }

    generateCode(codegen) {
        var properties = this.properties;

        if (!properties || !properties.length) {
            codegen.write('{}');
            return;
        }

        codegen.incIndent();
        codegen.write('{\n');
        codegen.incIndent();

        properties.forEach((prop, i) => {
            codegen.writeLineIndent();
            codegen.generateCode(prop);

            if (i < properties.length - 1) {
                codegen.write(',\n');
            } else {
                codegen.write('\n');
            }
        });

        codegen.decIndent();
        codegen.writeLineIndent();
        codegen.write('}');
        codegen.decIndent();
    }

    toJSON() {
        return {
            type: 'ObjectExpression',
            properties: this.properties
        };
    }

    walk(walker) {
        this.properties = walker.walk(this.properties);
    }

    toString(codegen) {
        var properties = this.properties;

        if (!properties || !properties.length) {
            return '{}';
        }

        let result = '{';

        properties.forEach((prop, i) => {
            if (i !== 0) {
                result += ', ';
            }
            result += prop;
        });

        return result + '}';    }
}

module.exports = ObjectExpression;
});
$rmod.def("/marko@3.3.0/compiler/ast/ArrayExpression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class ArrayExpression extends Node {
    constructor(def) {
        super('ArrayExpression');
        this.elements = def.elements;
    }

    generateCode(codegen) {
        var elements = this.elements;

        if (!elements || !elements.length) {
            codegen.write('[]');
            return;
        }

        codegen.incIndent();
        codegen.write('[\n');
        codegen.incIndent();

        elements.forEach((element, i) => {
            codegen.writeLineIndent();
            codegen.generateCode(element);

            if (i < elements.length - 1) {
                codegen.write(',\n');
            } else {
                codegen.write('\n');
            }
        });

        codegen.decIndent();
        codegen.writeLineIndent();
        codegen.write(']');
        codegen.decIndent();
    }

    walk(walker) {
        this.elements = walker.walk(this.elements);
    }

    toJSON() {
        return {
            type: 'ArrayExpression',
            elements: this.elements
        };
    }

    toString() {
        var result = '[';
        var elements = this.elements;
        if (elements) {
            elements.forEach((element, i) => {
                if (i !== 0) {
                    result += ', ';
                }
                result += element.toString();
            });
        }

        return result + ']';
    }
}

module.exports = ArrayExpression;
});
$rmod.def("/marko@3.3.0/compiler/ast/Property", function(require, exports, module, __filename, __dirname) { 'use strict';
const isValidJavaScriptIdentifier = require('../util/isValidJavaScriptIdentifier');
const Node = require('./Node');

class Property extends Node {
    constructor(def) {
        super('Property');
        this.key = def.key;
        this.value = def.value;
    }

    generateCode(codegen) {
        var key = this.key;
        var value = this.value;

        if (key.type === 'Literal') {
            var propName = key.value;
            if (isValidJavaScriptIdentifier(propName)) {
                key = codegen.builder.identifier(propName);
            }
        }

        codegen.generateCode(key);
        codegen.write(': ');
        codegen.generateCode(value);
    }

    toJSON() {
        return {
            type: 'Property',
            key: this.key,
            value: this.value
        };
    }

    walk(walker) {
        this.key = walker.walk(this.key);
        this.value = walker.walk(this.value);
    }

    toString() {
        var key = this.key;
        var value = this.value;

        if (key.type === 'Literal') {
            var propName = key.value;
            if (isValidJavaScriptIdentifier(propName)) {
                key = propName;
            }
        }

        return key + ': ' + value;
    }
}

module.exports = Property;
});
$rmod.def("/marko@3.3.0/compiler/ast/VariableDeclarator", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var Identifier = require('./Identifier');
var isValidJavaScriptVarName = require('../util/isValidJavaScriptVarName');

class VariableDeclarator extends Node {
    constructor(def) {
        super('VariableDeclarator');
        this.id = def.id;
        this.init = def.init;

        let name = this.id.name;
        if (!name) {
            throw new Error('"name" is required');
        }

        if (!isValidJavaScriptVarName(name)) {
            var error = new Error('Invalid JavaScript variable name: ' + name);
            error.code = 'INVALID_VAR_NAME';
            throw error;
        }
    }

    generateCode(codegen) {
        var id = this.id;
        var init = this.init;

        if (!(id instanceof Identifier) && typeof id !== 'string') {
            throw new Error('Invalid variable name: ' + id);
        }

        codegen.generateCode(id);

        if (init != null) {
            codegen.write(' = ');
            codegen.generateCode(init);
        }
    }

    walk(walker) {
        this.id = walker.walk(this.id);
        this.init = walker.walk(this.init);
    }
}

module.exports = VariableDeclarator;
});
$rmod.def("/marko@3.3.0/compiler/ast/ThisExpression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class ThisExpression extends Node {
    constructor(def) {
        super('ThisExpression');
    }

    generateCode(codegen) {
        codegen.write('this');
    }

    toString() {
        return 'this';
    }
}

module.exports = ThisExpression;
});
$rmod.def("/marko@3.3.0/compiler/ast/Expression", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var ok = require('/$/assert'/*'assert'*/).ok;

class Expression extends Node {
    constructor(def) {
        super('Expression');
        this.value = def.value;
        ok(this.value != null, 'Invalid expression');
    }

    generateCode(codegen) {
        codegen.generateCode(this.value);
    }

    isCompoundExpression() {
        return true;
    }

    toString() {
        return this.value;
    }
}

module.exports = Expression;
});
$rmod.def("/marko@3.3.0/compiler/ast/Scriptlet", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');
var adjustIndent = require('../util/adjustIndent');

class Scriptlet extends Node {
    constructor(def) {
        super('Scriptlet');
        this.code = def.code;
    }

    generateCode(codegen) {
        var code = this.code;

        if (!code) {
            return;
        }

        code = adjustIndent(code, codegen.currentIndent);

        codegen.write(code);
        codegen.write('\n');
    }
}

module.exports = Scriptlet;
});
$rmod.def("/marko@3.3.0/compiler/ast/ContainerNode", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class ContainerNode extends Node {
    constructor(def) {
        super('ContainerNode');
        this.body = this.makeContainer(def.body);
    }

    walk(walker) {
        this.body = walker.walk(this.body);
    }
}

module.exports = ContainerNode;
});
$rmod.def("/marko@3.3.0/compiler/ast/WhileStatement", function(require, exports, module, __filename, __dirname) { 'use strict';

var Node = require('./Node');

class WhileStatement extends Node {
    constructor(def) {
        super('WhileStatement');
        this.test = def.test;
        this.body = this.makeContainer(def.body);
    }

    generateCode(codegen) {
        var test = this.test;
        var body = this.body;

        codegen.write('while (');
        codegen.generateCode(test);
        codegen.write(') ');

        codegen.generateBlock(body);

        codegen.write('\n');
    }

    walk(walker) {
        this.test = walker.walk(this.test);
        this.body = walker.walk(this.body);
    }
}

module.exports = WhileStatement;
});
$rmod.def("/marko@3.3.0/compiler/ast/DocumentType", function(require, exports, module, __filename, __dirname) { 'use strict';
var Node = require('./Node');

class DocumentType extends Node {
    constructor(def) {
        super('DocumentType');
        this.documentType = def.documentType;
    }

    generateHtmlCode(codegen) {

        var builder = codegen.builder;

        codegen.addWrite(builder.literal('<!'));
        codegen.addWrite(this.documentType);
        codegen.addWrite(builder.literal('>'));
    }

    toJSON() {
        return {
            type: this.type,
            value: this.value
        };
    }
}

module.exports = DocumentType;
});
$rmod.def("/marko@3.3.0/compiler/ast/Declaration", function(require, exports, module, __filename, __dirname) { 'use strict';
var Node = require('./Node');

class Declaration extends Node {
    constructor(def) {
        super('Declaration');
        this.declaration = def.declaration;
    }

    generateHtmlCode(codegen) {

        var builder = codegen.builder;

        codegen.addWrite(builder.literal('<?'));
        codegen.addWrite(this.declaration);
        codegen.addWrite(builder.literal('?>'));
    }

    toJSON() {
        return {
            type: this.type,
            value: this.value
        };
    }
}

module.exports = Declaration;
});
$rmod.main("/esprima@2.7.2", "esprima");
$rmod.dep("", "esprima", "2.7.2");
$rmod.def("/esprima@2.7.2/esprima", function(require, exports, module, __filename, __dirname) { /*
  Copyright (c) jQuery Foundation, Inc. and Contributors, All Rights Reserved.

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
  ARE DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
  THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

(function (root, factory) {
    'use strict';

    // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js,
    // Rhino, and plain browser loading.

    /* istanbul ignore next */
    if (typeof define === 'function' && define.amd) {
        define(['exports'], factory);
    } else if (typeof exports !== 'undefined') {
        factory(exports);
    } else {
        factory((root.esprima = {}));
    }
}(this, function (exports) {
    'use strict';

    var Token,
        TokenName,
        FnExprTokens,
        Syntax,
        PlaceHolders,
        Messages,
        Regex,
        source,
        strict,
        index,
        lineNumber,
        lineStart,
        hasLineTerminator,
        lastIndex,
        lastLineNumber,
        lastLineStart,
        startIndex,
        startLineNumber,
        startLineStart,
        scanning,
        length,
        lookahead,
        state,
        extra,
        isBindingElement,
        isAssignmentTarget,
        firstCoverInitializedNameError;

    Token = {
        BooleanLiteral: 1,
        EOF: 2,
        Identifier: 3,
        Keyword: 4,
        NullLiteral: 5,
        NumericLiteral: 6,
        Punctuator: 7,
        StringLiteral: 8,
        RegularExpression: 9,
        Template: 10
    };

    TokenName = {};
    TokenName[Token.BooleanLiteral] = 'Boolean';
    TokenName[Token.EOF] = '<end>';
    TokenName[Token.Identifier] = 'Identifier';
    TokenName[Token.Keyword] = 'Keyword';
    TokenName[Token.NullLiteral] = 'Null';
    TokenName[Token.NumericLiteral] = 'Numeric';
    TokenName[Token.Punctuator] = 'Punctuator';
    TokenName[Token.StringLiteral] = 'String';
    TokenName[Token.RegularExpression] = 'RegularExpression';
    TokenName[Token.Template] = 'Template';

    // A function following one of those tokens is an expression.
    FnExprTokens = ['(', '{', '[', 'in', 'typeof', 'instanceof', 'new',
                    'return', 'case', 'delete', 'throw', 'void',
                    // assignment operators
                    '=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '>>>=',
                    '&=', '|=', '^=', ',',
                    // binary/unary operators
                    '+', '-', '*', '/', '%', '++', '--', '<<', '>>', '>>>', '&',
                    '|', '^', '!', '~', '&&', '||', '?', ':', '===', '==', '>=',
                    '<=', '<', '>', '!=', '!=='];

    Syntax = {
        AssignmentExpression: 'AssignmentExpression',
        AssignmentPattern: 'AssignmentPattern',
        ArrayExpression: 'ArrayExpression',
        ArrayPattern: 'ArrayPattern',
        ArrowFunctionExpression: 'ArrowFunctionExpression',
        BlockStatement: 'BlockStatement',
        BinaryExpression: 'BinaryExpression',
        BreakStatement: 'BreakStatement',
        CallExpression: 'CallExpression',
        CatchClause: 'CatchClause',
        ClassBody: 'ClassBody',
        ClassDeclaration: 'ClassDeclaration',
        ClassExpression: 'ClassExpression',
        ConditionalExpression: 'ConditionalExpression',
        ContinueStatement: 'ContinueStatement',
        DoWhileStatement: 'DoWhileStatement',
        DebuggerStatement: 'DebuggerStatement',
        EmptyStatement: 'EmptyStatement',
        ExportAllDeclaration: 'ExportAllDeclaration',
        ExportDefaultDeclaration: 'ExportDefaultDeclaration',
        ExportNamedDeclaration: 'ExportNamedDeclaration',
        ExportSpecifier: 'ExportSpecifier',
        ExpressionStatement: 'ExpressionStatement',
        ForStatement: 'ForStatement',
        ForOfStatement: 'ForOfStatement',
        ForInStatement: 'ForInStatement',
        FunctionDeclaration: 'FunctionDeclaration',
        FunctionExpression: 'FunctionExpression',
        Identifier: 'Identifier',
        IfStatement: 'IfStatement',
        ImportDeclaration: 'ImportDeclaration',
        ImportDefaultSpecifier: 'ImportDefaultSpecifier',
        ImportNamespaceSpecifier: 'ImportNamespaceSpecifier',
        ImportSpecifier: 'ImportSpecifier',
        Literal: 'Literal',
        LabeledStatement: 'LabeledStatement',
        LogicalExpression: 'LogicalExpression',
        MemberExpression: 'MemberExpression',
        MetaProperty: 'MetaProperty',
        MethodDefinition: 'MethodDefinition',
        NewExpression: 'NewExpression',
        ObjectExpression: 'ObjectExpression',
        ObjectPattern: 'ObjectPattern',
        Program: 'Program',
        Property: 'Property',
        RestElement: 'RestElement',
        ReturnStatement: 'ReturnStatement',
        SequenceExpression: 'SequenceExpression',
        SpreadElement: 'SpreadElement',
        Super: 'Super',
        SwitchCase: 'SwitchCase',
        SwitchStatement: 'SwitchStatement',
        TaggedTemplateExpression: 'TaggedTemplateExpression',
        TemplateElement: 'TemplateElement',
        TemplateLiteral: 'TemplateLiteral',
        ThisExpression: 'ThisExpression',
        ThrowStatement: 'ThrowStatement',
        TryStatement: 'TryStatement',
        UnaryExpression: 'UnaryExpression',
        UpdateExpression: 'UpdateExpression',
        VariableDeclaration: 'VariableDeclaration',
        VariableDeclarator: 'VariableDeclarator',
        WhileStatement: 'WhileStatement',
        WithStatement: 'WithStatement',
        YieldExpression: 'YieldExpression'
    };

    PlaceHolders = {
        ArrowParameterPlaceHolder: 'ArrowParameterPlaceHolder'
    };

    // Error messages should be identical to V8.
    Messages = {
        UnexpectedToken: 'Unexpected token %0',
        UnexpectedNumber: 'Unexpected number',
        UnexpectedString: 'Unexpected string',
        UnexpectedIdentifier: 'Unexpected identifier',
        UnexpectedReserved: 'Unexpected reserved word',
        UnexpectedTemplate: 'Unexpected quasi %0',
        UnexpectedEOS: 'Unexpected end of input',
        NewlineAfterThrow: 'Illegal newline after throw',
        InvalidRegExp: 'Invalid regular expression',
        UnterminatedRegExp: 'Invalid regular expression: missing /',
        InvalidLHSInAssignment: 'Invalid left-hand side in assignment',
        InvalidLHSInForIn: 'Invalid left-hand side in for-in',
        InvalidLHSInForLoop: 'Invalid left-hand side in for-loop',
        MultipleDefaultsInSwitch: 'More than one default clause in switch statement',
        NoCatchOrFinally: 'Missing catch or finally after try',
        UnknownLabel: 'Undefined label \'%0\'',
        Redeclaration: '%0 \'%1\' has already been declared',
        IllegalContinue: 'Illegal continue statement',
        IllegalBreak: 'Illegal break statement',
        IllegalReturn: 'Illegal return statement',
        StrictModeWith: 'Strict mode code may not include a with statement',
        StrictCatchVariable: 'Catch variable may not be eval or arguments in strict mode',
        StrictVarName: 'Variable name may not be eval or arguments in strict mode',
        StrictParamName: 'Parameter name eval or arguments is not allowed in strict mode',
        StrictParamDupe: 'Strict mode function may not have duplicate parameter names',
        StrictFunctionName: 'Function name may not be eval or arguments in strict mode',
        StrictOctalLiteral: 'Octal literals are not allowed in strict mode.',
        StrictDelete: 'Delete of an unqualified identifier in strict mode.',
        StrictLHSAssignment: 'Assignment to eval or arguments is not allowed in strict mode',
        StrictLHSPostfix: 'Postfix increment/decrement may not have eval or arguments operand in strict mode',
        StrictLHSPrefix: 'Prefix increment/decrement may not have eval or arguments operand in strict mode',
        StrictReservedWord: 'Use of future reserved word in strict mode',
        TemplateOctalLiteral: 'Octal literals are not allowed in template strings.',
        ParameterAfterRestParameter: 'Rest parameter must be last formal parameter',
        DefaultRestParameter: 'Unexpected token =',
        ObjectPatternAsRestParameter: 'Unexpected token {',
        DuplicateProtoProperty: 'Duplicate __proto__ fields are not allowed in object literals',
        ConstructorSpecialMethod: 'Class constructor may not be an accessor',
        DuplicateConstructor: 'A class may only have one constructor',
        StaticPrototype: 'Classes may not have static property named prototype',
        MissingFromClause: 'Unexpected token',
        NoAsAfterImportNamespace: 'Unexpected token',
        InvalidModuleSpecifier: 'Unexpected token',
        IllegalImportDeclaration: 'Unexpected token',
        IllegalExportDeclaration: 'Unexpected token',
        DuplicateBinding: 'Duplicate binding %0'
    };

    // See also tools/generate-unicode-regex.js.
    Regex = {
        // ECMAScript 6/Unicode v7.0.0 NonAsciiIdentifierStart:
        NonAsciiIdentifierStart: /[\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u05D0-\u05EA\u05F0-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u08A0-\u08B2\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58\u0C59\u0C60\u0C61\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D60\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1877\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19C1-\u19C7\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4B\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1CE9-\u1CEC\u1CEE-\u1CF1\u1CF5\u1CF6\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA7AD\uA7B0\uA7B1\uA7F7-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB5F\uAB64\uAB65\uABC0-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDE80-\uDE9C\uDEA0-\uDED0\uDF00-\uDF1F\uDF30-\uDF4A\uDF50-\uDF75\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00\uDE10-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE4\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48]|\uD804[\uDC03-\uDC37\uDC83-\uDCAF\uDCD0-\uDCE8\uDD03-\uDD26\uDD50-\uDD72\uDD76\uDD83-\uDDB2\uDDC1-\uDDC4\uDDDA\uDE00-\uDE11\uDE13-\uDE2B\uDEB0-\uDEDE\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3D\uDF5D-\uDF61]|\uD805[\uDC80-\uDCAF\uDCC4\uDCC5\uDCC7\uDD80-\uDDAE\uDE00-\uDE2F\uDE44\uDE80-\uDEAA]|\uD806[\uDCA0-\uDCDF\uDCFF\uDEC0-\uDEF8]|\uD808[\uDC00-\uDF98]|\uD809[\uDC00-\uDC6E]|[\uD80C\uD840-\uD868\uD86A-\uD86C][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDED0-\uDEED\uDF00-\uDF2F\uDF40-\uDF43\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50\uDF93-\uDF9F]|\uD82C[\uDC00\uDC01]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB]|\uD83A[\uDC00-\uDCC4]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D]|\uD87E[\uDC00-\uDE1D]/,

        // ECMAScript 6/Unicode v7.0.0 NonAsciiIdentifierPart:
        NonAsciiIdentifierPart: /[\xAA\xB5\xB7\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0300-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u0483-\u0487\u048A-\u052F\u0531-\u0556\u0559\u0561-\u0587\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u05D0-\u05EA\u05F0-\u05F2\u0610-\u061A\u0620-\u0669\u066E-\u06D3\u06D5-\u06DC\u06DF-\u06E8\u06EA-\u06FC\u06FF\u0710-\u074A\u074D-\u07B1\u07C0-\u07F5\u07FA\u0800-\u082D\u0840-\u085B\u08A0-\u08B2\u08E4-\u0963\u0966-\u096F\u0971-\u0983\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BC-\u09C4\u09C7\u09C8\u09CB-\u09CE\u09D7\u09DC\u09DD\u09DF-\u09E3\u09E6-\u09F1\u0A01-\u0A03\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A59-\u0A5C\u0A5E\u0A66-\u0A75\u0A81-\u0A83\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABC-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AD0\u0AE0-\u0AE3\u0AE6-\u0AEF\u0B01-\u0B03\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3C-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B56\u0B57\u0B5C\u0B5D\u0B5F-\u0B63\u0B66-\u0B6F\u0B71\u0B82\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD0\u0BD7\u0BE6-\u0BEF\u0C00-\u0C03\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C58\u0C59\u0C60-\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBC-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CDE\u0CE0-\u0CE3\u0CE6-\u0CEF\u0CF1\u0CF2\u0D01-\u0D03\u0D05-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D-\u0D44\u0D46-\u0D48\u0D4A-\u0D4E\u0D57\u0D60-\u0D63\u0D66-\u0D6F\u0D7A-\u0D7F\u0D82\u0D83\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E01-\u0E3A\u0E40-\u0E4E\u0E50-\u0E59\u0E81\u0E82\u0E84\u0E87\u0E88\u0E8A\u0E8D\u0E94-\u0E97\u0E99-\u0E9F\u0EA1-\u0EA3\u0EA5\u0EA7\u0EAA\u0EAB\u0EAD-\u0EB9\u0EBB-\u0EBD\u0EC0-\u0EC4\u0EC6\u0EC8-\u0ECD\u0ED0-\u0ED9\u0EDC-\u0EDF\u0F00\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E-\u0F47\u0F49-\u0F6C\u0F71-\u0F84\u0F86-\u0F97\u0F99-\u0FBC\u0FC6\u1000-\u1049\u1050-\u109D\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u135D-\u135F\u1369-\u1371\u1380-\u138F\u13A0-\u13F4\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u170C\u170E-\u1714\u1720-\u1734\u1740-\u1753\u1760-\u176C\u176E-\u1770\u1772\u1773\u1780-\u17D3\u17D7\u17DC\u17DD\u17E0-\u17E9\u180B-\u180D\u1810-\u1819\u1820-\u1877\u1880-\u18AA\u18B0-\u18F5\u1900-\u191E\u1920-\u192B\u1930-\u193B\u1946-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u19D0-\u19DA\u1A00-\u1A1B\u1A20-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AA7\u1AB0-\u1ABD\u1B00-\u1B4B\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1BF3\u1C00-\u1C37\u1C40-\u1C49\u1C4D-\u1C7D\u1CD0-\u1CD2\u1CD4-\u1CF6\u1CF8\u1CF9\u1D00-\u1DF5\u1DFC-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u200C\u200D\u203F\u2040\u2054\u2071\u207F\u2090-\u209C\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2C2E\u2C30-\u2C5E\u2C60-\u2CE4\u2CEB-\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D7F-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u2DE0-\u2DFF\u3005-\u3007\u3021-\u302F\u3031-\u3035\u3038-\u303C\u3041-\u3096\u3099-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312D\u3131-\u318E\u31A0-\u31BA\u31F0-\u31FF\u3400-\u4DB5\u4E00-\u9FCC\uA000-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA62B\uA640-\uA66F\uA674-\uA67D\uA67F-\uA69D\uA69F-\uA6F1\uA717-\uA71F\uA722-\uA788\uA78B-\uA78E\uA790-\uA7AD\uA7B0\uA7B1\uA7F7-\uA827\uA840-\uA873\uA880-\uA8C4\uA8D0-\uA8D9\uA8E0-\uA8F7\uA8FB\uA900-\uA92D\uA930-\uA953\uA960-\uA97C\uA980-\uA9C0\uA9CF-\uA9D9\uA9E0-\uA9FE\uAA00-\uAA36\uAA40-\uAA4D\uAA50-\uAA59\uAA60-\uAA76\uAA7A-\uAAC2\uAADB-\uAADD\uAAE0-\uAAEF\uAAF2-\uAAF6\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB5F\uAB64\uAB65\uABC0-\uABEA\uABEC\uABED\uABF0-\uABF9\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE00-\uFE0F\uFE20-\uFE2D\uFE33\uFE34\uFE4D-\uFE4F\uFE70-\uFE74\uFE76-\uFEFC\uFF10-\uFF19\uFF21-\uFF3A\uFF3F\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC]|\uD800[\uDC00-\uDC0B\uDC0D-\uDC26\uDC28-\uDC3A\uDC3C\uDC3D\uDC3F-\uDC4D\uDC50-\uDC5D\uDC80-\uDCFA\uDD40-\uDD74\uDDFD\uDE80-\uDE9C\uDEA0-\uDED0\uDEE0\uDF00-\uDF1F\uDF30-\uDF4A\uDF50-\uDF7A\uDF80-\uDF9D\uDFA0-\uDFC3\uDFC8-\uDFCF\uDFD1-\uDFD5]|\uD801[\uDC00-\uDC9D\uDCA0-\uDCA9\uDD00-\uDD27\uDD30-\uDD63\uDE00-\uDF36\uDF40-\uDF55\uDF60-\uDF67]|\uD802[\uDC00-\uDC05\uDC08\uDC0A-\uDC35\uDC37\uDC38\uDC3C\uDC3F-\uDC55\uDC60-\uDC76\uDC80-\uDC9E\uDD00-\uDD15\uDD20-\uDD39\uDD80-\uDDB7\uDDBE\uDDBF\uDE00-\uDE03\uDE05\uDE06\uDE0C-\uDE13\uDE15-\uDE17\uDE19-\uDE33\uDE38-\uDE3A\uDE3F\uDE60-\uDE7C\uDE80-\uDE9C\uDEC0-\uDEC7\uDEC9-\uDEE6\uDF00-\uDF35\uDF40-\uDF55\uDF60-\uDF72\uDF80-\uDF91]|\uD803[\uDC00-\uDC48]|\uD804[\uDC00-\uDC46\uDC66-\uDC6F\uDC7F-\uDCBA\uDCD0-\uDCE8\uDCF0-\uDCF9\uDD00-\uDD34\uDD36-\uDD3F\uDD50-\uDD73\uDD76\uDD80-\uDDC4\uDDD0-\uDDDA\uDE00-\uDE11\uDE13-\uDE37\uDEB0-\uDEEA\uDEF0-\uDEF9\uDF01-\uDF03\uDF05-\uDF0C\uDF0F\uDF10\uDF13-\uDF28\uDF2A-\uDF30\uDF32\uDF33\uDF35-\uDF39\uDF3C-\uDF44\uDF47\uDF48\uDF4B-\uDF4D\uDF57\uDF5D-\uDF63\uDF66-\uDF6C\uDF70-\uDF74]|\uD805[\uDC80-\uDCC5\uDCC7\uDCD0-\uDCD9\uDD80-\uDDB5\uDDB8-\uDDC0\uDE00-\uDE40\uDE44\uDE50-\uDE59\uDE80-\uDEB7\uDEC0-\uDEC9]|\uD806[\uDCA0-\uDCE9\uDCFF\uDEC0-\uDEF8]|\uD808[\uDC00-\uDF98]|\uD809[\uDC00-\uDC6E]|[\uD80C\uD840-\uD868\uD86A-\uD86C][\uDC00-\uDFFF]|\uD80D[\uDC00-\uDC2E]|\uD81A[\uDC00-\uDE38\uDE40-\uDE5E\uDE60-\uDE69\uDED0-\uDEED\uDEF0-\uDEF4\uDF00-\uDF36\uDF40-\uDF43\uDF50-\uDF59\uDF63-\uDF77\uDF7D-\uDF8F]|\uD81B[\uDF00-\uDF44\uDF50-\uDF7E\uDF8F-\uDF9F]|\uD82C[\uDC00\uDC01]|\uD82F[\uDC00-\uDC6A\uDC70-\uDC7C\uDC80-\uDC88\uDC90-\uDC99\uDC9D\uDC9E]|\uD834[\uDD65-\uDD69\uDD6D-\uDD72\uDD7B-\uDD82\uDD85-\uDD8B\uDDAA-\uDDAD\uDE42-\uDE44]|\uD835[\uDC00-\uDC54\uDC56-\uDC9C\uDC9E\uDC9F\uDCA2\uDCA5\uDCA6\uDCA9-\uDCAC\uDCAE-\uDCB9\uDCBB\uDCBD-\uDCC3\uDCC5-\uDD05\uDD07-\uDD0A\uDD0D-\uDD14\uDD16-\uDD1C\uDD1E-\uDD39\uDD3B-\uDD3E\uDD40-\uDD44\uDD46\uDD4A-\uDD50\uDD52-\uDEA5\uDEA8-\uDEC0\uDEC2-\uDEDA\uDEDC-\uDEFA\uDEFC-\uDF14\uDF16-\uDF34\uDF36-\uDF4E\uDF50-\uDF6E\uDF70-\uDF88\uDF8A-\uDFA8\uDFAA-\uDFC2\uDFC4-\uDFCB\uDFCE-\uDFFF]|\uD83A[\uDC00-\uDCC4\uDCD0-\uDCD6]|\uD83B[\uDE00-\uDE03\uDE05-\uDE1F\uDE21\uDE22\uDE24\uDE27\uDE29-\uDE32\uDE34-\uDE37\uDE39\uDE3B\uDE42\uDE47\uDE49\uDE4B\uDE4D-\uDE4F\uDE51\uDE52\uDE54\uDE57\uDE59\uDE5B\uDE5D\uDE5F\uDE61\uDE62\uDE64\uDE67-\uDE6A\uDE6C-\uDE72\uDE74-\uDE77\uDE79-\uDE7C\uDE7E\uDE80-\uDE89\uDE8B-\uDE9B\uDEA1-\uDEA3\uDEA5-\uDEA9\uDEAB-\uDEBB]|\uD869[\uDC00-\uDED6\uDF00-\uDFFF]|\uD86D[\uDC00-\uDF34\uDF40-\uDFFF]|\uD86E[\uDC00-\uDC1D]|\uD87E[\uDC00-\uDE1D]|\uDB40[\uDD00-\uDDEF]/
    };

    // Ensure the condition is true, otherwise throw an error.
    // This is only to have a better contract semantic, i.e. another safety net
    // to catch a logic error. The condition shall be fulfilled in normal case.
    // Do NOT use this to enforce a certain condition on any user input.

    function assert(condition, message) {
        /* istanbul ignore if */
        if (!condition) {
            throw new Error('ASSERT: ' + message);
        }
    }

    function isDecimalDigit(ch) {
        return (ch >= 0x30 && ch <= 0x39);   // 0..9
    }

    function isHexDigit(ch) {
        return '0123456789abcdefABCDEF'.indexOf(ch) >= 0;
    }

    function isOctalDigit(ch) {
        return '01234567'.indexOf(ch) >= 0;
    }

    function octalToDecimal(ch) {
        // \0 is not octal escape sequence
        var octal = (ch !== '0'), code = '01234567'.indexOf(ch);

        if (index < length && isOctalDigit(source[index])) {
            octal = true;
            code = code * 8 + '01234567'.indexOf(source[index++]);

            // 3 digits are only allowed when string starts
            // with 0, 1, 2, 3
            if ('0123'.indexOf(ch) >= 0 &&
                    index < length &&
                    isOctalDigit(source[index])) {
                code = code * 8 + '01234567'.indexOf(source[index++]);
            }
        }

        return {
            code: code,
            octal: octal
        };
    }

    // ECMA-262 11.2 White Space

    function isWhiteSpace(ch) {
        return (ch === 0x20) || (ch === 0x09) || (ch === 0x0B) || (ch === 0x0C) || (ch === 0xA0) ||
            (ch >= 0x1680 && [0x1680, 0x180E, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x202F, 0x205F, 0x3000, 0xFEFF].indexOf(ch) >= 0);
    }

    // ECMA-262 11.3 Line Terminators

    function isLineTerminator(ch) {
        return (ch === 0x0A) || (ch === 0x0D) || (ch === 0x2028) || (ch === 0x2029);
    }

    // ECMA-262 11.6 Identifier Names and Identifiers

    function fromCodePoint(cp) {
        return (cp < 0x10000) ? String.fromCharCode(cp) :
            String.fromCharCode(0xD800 + ((cp - 0x10000) >> 10)) +
            String.fromCharCode(0xDC00 + ((cp - 0x10000) & 1023));
    }

    function isIdentifierStart(ch) {
        return (ch === 0x24) || (ch === 0x5F) ||  // $ (dollar) and _ (underscore)
            (ch >= 0x41 && ch <= 0x5A) ||         // A..Z
            (ch >= 0x61 && ch <= 0x7A) ||         // a..z
            (ch === 0x5C) ||                      // \ (backslash)
            ((ch >= 0x80) && Regex.NonAsciiIdentifierStart.test(fromCodePoint(ch)));
    }

    function isIdentifierPart(ch) {
        return (ch === 0x24) || (ch === 0x5F) ||  // $ (dollar) and _ (underscore)
            (ch >= 0x41 && ch <= 0x5A) ||         // A..Z
            (ch >= 0x61 && ch <= 0x7A) ||         // a..z
            (ch >= 0x30 && ch <= 0x39) ||         // 0..9
            (ch === 0x5C) ||                      // \ (backslash)
            ((ch >= 0x80) && Regex.NonAsciiIdentifierPart.test(fromCodePoint(ch)));
    }

    // ECMA-262 11.6.2.2 Future Reserved Words

    function isFutureReservedWord(id) {
        switch (id) {
        case 'enum':
        case 'export':
        case 'import':
        case 'super':
            return true;
        default:
            return false;
        }
    }

    function isStrictModeReservedWord(id) {
        switch (id) {
        case 'implements':
        case 'interface':
        case 'package':
        case 'private':
        case 'protected':
        case 'public':
        case 'static':
        case 'yield':
        case 'let':
            return true;
        default:
            return false;
        }
    }

    function isRestrictedWord(id) {
        return id === 'eval' || id === 'arguments';
    }

    // ECMA-262 11.6.2.1 Keywords

    function isKeyword(id) {
        switch (id.length) {
        case 2:
            return (id === 'if') || (id === 'in') || (id === 'do');
        case 3:
            return (id === 'var') || (id === 'for') || (id === 'new') ||
                (id === 'try') || (id === 'let');
        case 4:
            return (id === 'this') || (id === 'else') || (id === 'case') ||
                (id === 'void') || (id === 'with') || (id === 'enum');
        case 5:
            return (id === 'while') || (id === 'break') || (id === 'catch') ||
                (id === 'throw') || (id === 'const') || (id === 'yield') ||
                (id === 'class') || (id === 'super');
        case 6:
            return (id === 'return') || (id === 'typeof') || (id === 'delete') ||
                (id === 'switch') || (id === 'export') || (id === 'import');
        case 7:
            return (id === 'default') || (id === 'finally') || (id === 'extends');
        case 8:
            return (id === 'function') || (id === 'continue') || (id === 'debugger');
        case 10:
            return (id === 'instanceof');
        default:
            return false;
        }
    }

    // ECMA-262 11.4 Comments

    function addComment(type, value, start, end, loc) {
        var comment;

        assert(typeof start === 'number', 'Comment must have valid position');

        state.lastCommentStart = start;

        comment = {
            type: type,
            value: value
        };
        if (extra.range) {
            comment.range = [start, end];
        }
        if (extra.loc) {
            comment.loc = loc;
        }
        extra.comments.push(comment);
        if (extra.attachComment) {
            extra.leadingComments.push(comment);
            extra.trailingComments.push(comment);
        }
        if (extra.tokenize) {
            comment.type = comment.type + 'Comment';
            if (extra.delegate) {
                comment = extra.delegate(comment);
            }
            extra.tokens.push(comment);
        }
    }

    function skipSingleLineComment(offset) {
        var start, loc, ch, comment;

        start = index - offset;
        loc = {
            start: {
                line: lineNumber,
                column: index - lineStart - offset
            }
        };

        while (index < length) {
            ch = source.charCodeAt(index);
            ++index;
            if (isLineTerminator(ch)) {
                hasLineTerminator = true;
                if (extra.comments) {
                    comment = source.slice(start + offset, index - 1);
                    loc.end = {
                        line: lineNumber,
                        column: index - lineStart - 1
                    };
                    addComment('Line', comment, start, index - 1, loc);
                }
                if (ch === 13 && source.charCodeAt(index) === 10) {
                    ++index;
                }
                ++lineNumber;
                lineStart = index;
                return;
            }
        }

        if (extra.comments) {
            comment = source.slice(start + offset, index);
            loc.end = {
                line: lineNumber,
                column: index - lineStart
            };
            addComment('Line', comment, start, index, loc);
        }
    }

    function skipMultiLineComment() {
        var start, loc, ch, comment;

        if (extra.comments) {
            start = index - 2;
            loc = {
                start: {
                    line: lineNumber,
                    column: index - lineStart - 2
                }
            };
        }

        while (index < length) {
            ch = source.charCodeAt(index);
            if (isLineTerminator(ch)) {
                if (ch === 0x0D && source.charCodeAt(index + 1) === 0x0A) {
                    ++index;
                }
                hasLineTerminator = true;
                ++lineNumber;
                ++index;
                lineStart = index;
            } else if (ch === 0x2A) {
                // Block comment ends with '*/'.
                if (source.charCodeAt(index + 1) === 0x2F) {
                    ++index;
                    ++index;
                    if (extra.comments) {
                        comment = source.slice(start + 2, index - 2);
                        loc.end = {
                            line: lineNumber,
                            column: index - lineStart
                        };
                        addComment('Block', comment, start, index, loc);
                    }
                    return;
                }
                ++index;
            } else {
                ++index;
            }
        }

        // Ran off the end of the file - the whole thing is a comment
        if (extra.comments) {
            loc.end = {
                line: lineNumber,
                column: index - lineStart
            };
            comment = source.slice(start + 2, index);
            addComment('Block', comment, start, index, loc);
        }
        tolerateUnexpectedToken();
    }

    function skipComment() {
        var ch, start;
        hasLineTerminator = false;

        start = (index === 0);
        while (index < length) {
            ch = source.charCodeAt(index);

            if (isWhiteSpace(ch)) {
                ++index;
            } else if (isLineTerminator(ch)) {
                hasLineTerminator = true;
                ++index;
                if (ch === 0x0D && source.charCodeAt(index) === 0x0A) {
                    ++index;
                }
                ++lineNumber;
                lineStart = index;
                start = true;
            } else if (ch === 0x2F) { // U+002F is '/'
                ch = source.charCodeAt(index + 1);
                if (ch === 0x2F) {
                    ++index;
                    ++index;
                    skipSingleLineComment(2);
                    start = true;
                } else if (ch === 0x2A) {  // U+002A is '*'
                    ++index;
                    ++index;
                    skipMultiLineComment();
                } else {
                    break;
                }
            } else if (start && ch === 0x2D) { // U+002D is '-'
                // U+003E is '>'
                if ((source.charCodeAt(index + 1) === 0x2D) && (source.charCodeAt(index + 2) === 0x3E)) {
                    // '-->' is a single-line comment
                    index += 3;
                    skipSingleLineComment(3);
                } else {
                    break;
                }
            } else if (ch === 0x3C) { // U+003C is '<'
                if (source.slice(index + 1, index + 4) === '!--') {
                    ++index; // `<`
                    ++index; // `!`
                    ++index; // `-`
                    ++index; // `-`
                    skipSingleLineComment(4);
                } else {
                    break;
                }
            } else {
                break;
            }
        }
    }

    function scanHexEscape(prefix) {
        var i, len, ch, code = 0;

        len = (prefix === 'u') ? 4 : 2;
        for (i = 0; i < len; ++i) {
            if (index < length && isHexDigit(source[index])) {
                ch = source[index++];
                code = code * 16 + '0123456789abcdef'.indexOf(ch.toLowerCase());
            } else {
                return '';
            }
        }
        return String.fromCharCode(code);
    }

    function scanUnicodeCodePointEscape() {
        var ch, code;

        ch = source[index];
        code = 0;

        // At least, one hex digit is required.
        if (ch === '}') {
            throwUnexpectedToken();
        }

        while (index < length) {
            ch = source[index++];
            if (!isHexDigit(ch)) {
                break;
            }
            code = code * 16 + '0123456789abcdef'.indexOf(ch.toLowerCase());
        }

        if (code > 0x10FFFF || ch !== '}') {
            throwUnexpectedToken();
        }

        return fromCodePoint(code);
    }

    function codePointAt(i) {
        var cp, first, second;

        cp = source.charCodeAt(i);
        if (cp >= 0xD800 && cp <= 0xDBFF) {
            second = source.charCodeAt(i + 1);
            if (second >= 0xDC00 && second <= 0xDFFF) {
                first = cp;
                cp = (first - 0xD800) * 0x400 + second - 0xDC00 + 0x10000;
            }
        }

        return cp;
    }

    function getComplexIdentifier() {
        var cp, ch, id;

        cp = codePointAt(index);
        id = fromCodePoint(cp);
        index += id.length;

        // '\u' (U+005C, U+0075) denotes an escaped character.
        if (cp === 0x5C) {
            if (source.charCodeAt(index) !== 0x75) {
                throwUnexpectedToken();
            }
            ++index;
            if (source[index] === '{') {
                ++index;
                ch = scanUnicodeCodePointEscape();
            } else {
                ch = scanHexEscape('u');
                cp = ch.charCodeAt(0);
                if (!ch || ch === '\\' || !isIdentifierStart(cp)) {
                    throwUnexpectedToken();
                }
            }
            id = ch;
        }

        while (index < length) {
            cp = codePointAt(index);
            if (!isIdentifierPart(cp)) {
                break;
            }
            ch = fromCodePoint(cp);
            id += ch;
            index += ch.length;

            // '\u' (U+005C, U+0075) denotes an escaped character.
            if (cp === 0x5C) {
                id = id.substr(0, id.length - 1);
                if (source.charCodeAt(index) !== 0x75) {
                    throwUnexpectedToken();
                }
                ++index;
                if (source[index] === '{') {
                    ++index;
                    ch = scanUnicodeCodePointEscape();
                } else {
                    ch = scanHexEscape('u');
                    cp = ch.charCodeAt(0);
                    if (!ch || ch === '\\' || !isIdentifierPart(cp)) {
                        throwUnexpectedToken();
                    }
                }
                id += ch;
            }
        }

        return id;
    }

    function getIdentifier() {
        var start, ch;

        start = index++;
        while (index < length) {
            ch = source.charCodeAt(index);
            if (ch === 0x5C) {
                // Blackslash (U+005C) marks Unicode escape sequence.
                index = start;
                return getComplexIdentifier();
            } else if (ch >= 0xD800 && ch < 0xDFFF) {
                // Need to handle surrogate pairs.
                index = start;
                return getComplexIdentifier();
            }
            if (isIdentifierPart(ch)) {
                ++index;
            } else {
                break;
            }
        }

        return source.slice(start, index);
    }

    function scanIdentifier() {
        var start, id, type;

        start = index;

        // Backslash (U+005C) starts an escaped character.
        id = (source.charCodeAt(index) === 0x5C) ? getComplexIdentifier() : getIdentifier();

        // There is no keyword or literal with only one character.
        // Thus, it must be an identifier.
        if (id.length === 1) {
            type = Token.Identifier;
        } else if (isKeyword(id)) {
            type = Token.Keyword;
        } else if (id === 'null') {
            type = Token.NullLiteral;
        } else if (id === 'true' || id === 'false') {
            type = Token.BooleanLiteral;
        } else {
            type = Token.Identifier;
        }

        return {
            type: type,
            value: id,
            lineNumber: lineNumber,
            lineStart: lineStart,
            start: start,
            end: index
        };
    }


    // ECMA-262 11.7 Punctuators

    function scanPunctuator() {
        var token, str;

        token = {
            type: Token.Punctuator,
            value: '',
            lineNumber: lineNumber,
            lineStart: lineStart,
            start: index,
            end: index
        };

        // Check for most common single-character punctuators.
        str = source[index];
        switch (str) {

        case '(':
            if (extra.tokenize) {
                extra.openParenToken = extra.tokenValues.length;
            }
            ++index;
            break;

        case '{':
            if (extra.tokenize) {
                extra.openCurlyToken = extra.tokenValues.length;
            }
            state.curlyStack.push('{');
            ++index;
            break;

        case '.':
            ++index;
            if (source[index] === '.' && source[index + 1] === '.') {
                // Spread operator: ...
                index += 2;
                str = '...';
            }
            break;

        case '}':
            ++index;
            state.curlyStack.pop();
            break;
        case ')':
        case ';':
        case ',':
        case '[':
        case ']':
        case ':':
        case '?':
        case '~':
            ++index;
            break;

        default:
            // 4-character punctuator.
            str = source.substr(index, 4);
            if (str === '>>>=') {
                index += 4;
            } else {

                // 3-character punctuators.
                str = str.substr(0, 3);
                if (str === '===' || str === '!==' || str === '>>>' ||
                    str === '<<=' || str === '>>=') {
                    index += 3;
                } else {

                    // 2-character punctuators.
                    str = str.substr(0, 2);
                    if (str === '&&' || str === '||' || str === '==' || str === '!=' ||
                        str === '+=' || str === '-=' || str === '*=' || str === '/=' ||
                        str === '++' || str === '--' || str === '<<' || str === '>>' ||
                        str === '&=' || str === '|=' || str === '^=' || str === '%=' ||
                        str === '<=' || str === '>=' || str === '=>') {
                        index += 2;
                    } else {

                        // 1-character punctuators.
                        str = source[index];
                        if ('<>=!+-*%&|^/'.indexOf(str) >= 0) {
                            ++index;
                        }
                    }
                }
            }
        }

        if (index === token.start) {
            throwUnexpectedToken();
        }

        token.end = index;
        token.value = str;
        return token;
    }

    // ECMA-262 11.8.3 Numeric Literals

    function scanHexLiteral(start) {
        var number = '';

        while (index < length) {
            if (!isHexDigit(source[index])) {
                break;
            }
            number += source[index++];
        }

        if (number.length === 0) {
            throwUnexpectedToken();
        }

        if (isIdentifierStart(source.charCodeAt(index))) {
            throwUnexpectedToken();
        }

        return {
            type: Token.NumericLiteral,
            value: parseInt('0x' + number, 16),
            lineNumber: lineNumber,
            lineStart: lineStart,
            start: start,
            end: index
        };
    }

    function scanBinaryLiteral(start) {
        var ch, number;

        number = '';

        while (index < length) {
            ch = source[index];
            if (ch !== '0' && ch !== '1') {
                break;
            }
            number += source[index++];
        }

        if (number.length === 0) {
            // only 0b or 0B
            throwUnexpectedToken();
        }

        if (index < length) {
            ch = source.charCodeAt(index);
            /* istanbul ignore else */
            if (isIdentifierStart(ch) || isDecimalDigit(ch)) {
                throwUnexpectedToken();
            }
        }

        return {
            type: Token.NumericLiteral,
            value: parseInt(number, 2),
            lineNumber: lineNumber,
            lineStart: lineStart,
            start: start,
            end: index
        };
    }

    function scanOctalLiteral(prefix, start) {
        var number, octal;

        if (isOctalDigit(prefix)) {
            octal = true;
            number = '0' + source[index++];
        } else {
            octal = false;
            ++index;
            number = '';
        }

        while (index < length) {
            if (!isOctalDigit(source[index])) {
                break;
            }
            number += source[index++];
        }

        if (!octal && number.length === 0) {
            // only 0o or 0O
            throwUnexpectedToken();
        }

        if (isIdentifierStart(source.charCodeAt(index)) || isDecimalDigit(source.charCodeAt(index))) {
            throwUnexpectedToken();
        }

        return {
            type: Token.NumericLiteral,
            value: parseInt(number, 8),
            octal: octal,
            lineNumber: lineNumber,
            lineStart: lineStart,
            start: start,
            end: index
        };
    }

    function isImplicitOctalLiteral() {
        var i, ch;

        // Implicit octal, unless there is a non-octal digit.
        // (Annex B.1.1 on Numeric Literals)
        for (i = index + 1; i < length; ++i) {
            ch = source[i];
            if (ch === '8' || ch === '9') {
                return false;
            }
            if (!isOctalDigit(ch)) {
                return true;
            }
        }

        return true;
    }

    function scanNumericLiteral() {
        var number, start, ch;

        ch = source[index];
        assert(isDecimalDigit(ch.charCodeAt(0)) || (ch === '.'),
            'Numeric literal must start with a decimal digit or a decimal point');

        start = index;
        number = '';
        if (ch !== '.') {
            number = source[index++];
            ch = source[index];

            // Hex number starts with '0x'.
            // Octal number starts with '0'.
            // Octal number in ES6 starts with '0o'.
            // Binary number in ES6 starts with '0b'.
            if (number === '0') {
                if (ch === 'x' || ch === 'X') {
                    ++index;
                    return scanHexLiteral(start);
                }
                if (ch === 'b' || ch === 'B') {
                    ++index;
                    return scanBinaryLiteral(start);
                }
                if (ch === 'o' || ch === 'O') {
                    return scanOctalLiteral(ch, start);
                }

                if (isOctalDigit(ch)) {
                    if (isImplicitOctalLiteral()) {
                        return scanOctalLiteral(ch, start);
                    }
                }
            }

            while (isDecimalDigit(source.charCodeAt(index))) {
                number += source[index++];
            }
            ch = source[index];
        }

        if (ch === '.') {
            number += source[index++];
            while (isDecimalDigit(source.charCodeAt(index))) {
                number += source[index++];
            }
            ch = source[index];
        }

        if (ch === 'e' || ch === 'E') {
            number += source[index++];

            ch = source[index];
            if (ch === '+' || ch === '-') {
                number += source[index++];
            }
            if (isDecimalDigit(source.charCodeAt(index))) {
                while (isDecimalDigit(source.charCodeAt(index))) {
                    number += source[index++];
                }
            } else {
                throwUnexpectedToken();
            }
        }

        if (isIdentifierStart(source.charCodeAt(index))) {
            throwUnexpectedToken();
        }

        return {
            type: Token.NumericLiteral,
            value: parseFloat(number),
            lineNumber: lineNumber,
            lineStart: lineStart,
            start: start,
            end: index
        };
    }

    // ECMA-262 11.8.4 String Literals

    function scanStringLiteral() {
        var str = '', quote, start, ch, unescaped, octToDec, octal = false;

        quote = source[index];
        assert((quote === '\'' || quote === '"'),
            'String literal must starts with a quote');

        start = index;
        ++index;

        while (index < length) {
            ch = source[index++];

            if (ch === quote) {
                quote = '';
                break;
            } else if (ch === '\\') {
                ch = source[index++];
                if (!ch || !isLineTerminator(ch.charCodeAt(0))) {
                    switch (ch) {
                    case 'u':
                    case 'x':
                        if (source[index] === '{') {
                            ++index;
                            str += scanUnicodeCodePointEscape();
                        } else {
                            unescaped = scanHexEscape(ch);
                            if (!unescaped) {
                                throw throwUnexpectedToken();
                            }
                            str += unescaped;
                        }
                        break;
                    case 'n':
                        str += '\n';
                        break;
                    case 'r':
                        str += '\r';
                        break;
                    case 't':
                        str += '\t';
                        break;
                    case 'b':
                        str += '\b';
                        break;
                    case 'f':
                        str += '\f';
                        break;
                    case 'v':
                        str += '\x0B';
                        break;
                    case '8':
                    case '9':
                        str += ch;
                        tolerateUnexpectedToken();
                        break;

                    default:
                        if (isOctalDigit(ch)) {
                            octToDec = octalToDecimal(ch);

                            octal = octToDec.octal || octal;
                            str += String.fromCharCode(octToDec.code);
                        } else {
                            str += ch;
                        }
                        break;
                    }
                } else {
                    ++lineNumber;
                    if (ch === '\r' && source[index] === '\n') {
                        ++index;
                    }
                    lineStart = index;
                }
            } else if (isLineTerminator(ch.charCodeAt(0))) {
                break;
            } else {
                str += ch;
            }
        }

        if (quote !== '') {
            index = start;
            throwUnexpectedToken();
        }

        return {
            type: Token.StringLiteral,
            value: str,
            octal: octal,
            lineNumber: startLineNumber,
            lineStart: startLineStart,
            start: start,
            end: index
        };
    }

    // ECMA-262 11.8.6 Template Literal Lexical Components

    function scanTemplate() {
        var cooked = '', ch, start, rawOffset, terminated, head, tail, restore, unescaped;

        terminated = false;
        tail = false;
        start = index;
        head = (source[index] === '`');
        rawOffset = 2;

        ++index;

        while (index < length) {
            ch = source[index++];
            if (ch === '`') {
                rawOffset = 1;
                tail = true;
                terminated = true;
                break;
            } else if (ch === '$') {
                if (source[index] === '{') {
                    state.curlyStack.push('${');
                    ++index;
                    terminated = true;
                    break;
                }
                cooked += ch;
            } else if (ch === '\\') {
                ch = source[index++];
                if (!isLineTerminator(ch.charCodeAt(0))) {
                    switch (ch) {
                    case 'n':
                        cooked += '\n';
                        break;
                    case 'r':
                        cooked += '\r';
                        break;
                    case 't':
                        cooked += '\t';
                        break;
                    case 'u':
                    case 'x':
                        if (source[index] === '{') {
                            ++index;
                            cooked += scanUnicodeCodePointEscape();
                        } else {
                            restore = index;
                            unescaped = scanHexEscape(ch);
                            if (unescaped) {
                                cooked += unescaped;
                            } else {
                                index = restore;
                                cooked += ch;
                            }
                        }
                        break;
                    case 'b':
                        cooked += '\b';
                        break;
                    case 'f':
                        cooked += '\f';
                        break;
                    case 'v':
                        cooked += '\v';
                        break;

                    default:
                        if (ch === '0') {
                            if (isDecimalDigit(source.charCodeAt(index))) {
                                // Illegal: \01 \02 and so on
                                throwError(Messages.TemplateOctalLiteral);
                            }
                            cooked += '\0';
                        } else if (isOctalDigit(ch)) {
                            // Illegal: \1 \2
                            throwError(Messages.TemplateOctalLiteral);
                        } else {
                            cooked += ch;
                        }
                        break;
                    }
                } else {
                    ++lineNumber;
                    if (ch === '\r' && source[index] === '\n') {
                        ++index;
                    }
                    lineStart = index;
                }
            } else if (isLineTerminator(ch.charCodeAt(0))) {
                ++lineNumber;
                if (ch === '\r' && source[index] === '\n') {
                    ++index;
                }
                lineStart = index;
                cooked += '\n';
            } else {
                cooked += ch;
            }
        }

        if (!terminated) {
            throwUnexpectedToken();
        }

        if (!head) {
            state.curlyStack.pop();
        }

        return {
            type: Token.Template,
            value: {
                cooked: cooked,
                raw: source.slice(start + 1, index - rawOffset)
            },
            head: head,
            tail: tail,
            lineNumber: lineNumber,
            lineStart: lineStart,
            start: start,
            end: index
        };
    }

    // ECMA-262 11.8.5 Regular Expression Literals

    function testRegExp(pattern, flags) {
        // The BMP character to use as a replacement for astral symbols when
        // translating an ES6 "u"-flagged pattern to an ES5-compatible
        // approximation.
        // Note: replacing with '\uFFFF' enables false positives in unlikely
        // scenarios. For example, `[\u{1044f}-\u{10440}]` is an invalid
        // pattern that would not be detected by this substitution.
        var astralSubstitute = '\uFFFF',
            tmp = pattern;

        if (flags.indexOf('u') >= 0) {
            tmp = tmp
                // Replace every Unicode escape sequence with the equivalent
                // BMP character or a constant ASCII code point in the case of
                // astral symbols. (See the above note on `astralSubstitute`
                // for more information.)
                .replace(/\\u\{([0-9a-fA-F]+)\}|\\u([a-fA-F0-9]{4})/g, function ($0, $1, $2) {
                    var codePoint = parseInt($1 || $2, 16);
                    if (codePoint > 0x10FFFF) {
                        throwUnexpectedToken(null, Messages.InvalidRegExp);
                    }
                    if (codePoint <= 0xFFFF) {
                        return String.fromCharCode(codePoint);
                    }
                    return astralSubstitute;
                })
                // Replace each paired surrogate with a single ASCII symbol to
                // avoid throwing on regular expressions that are only valid in
                // combination with the "u" flag.
                .replace(
                    /[\uD800-\uDBFF][\uDC00-\uDFFF]/g,
                    astralSubstitute
                );
        }

        // First, detect invalid regular expressions.
        try {
            RegExp(tmp);
        } catch (e) {
            throwUnexpectedToken(null, Messages.InvalidRegExp);
        }

        // Return a regular expression object for this pattern-flag pair, or
        // `null` in case the current environment doesn't support the flags it
        // uses.
        try {
            return new RegExp(pattern, flags);
        } catch (exception) {
            return null;
        }
    }

    function scanRegExpBody() {
        var ch, str, classMarker, terminated, body;

        ch = source[index];
        assert(ch === '/', 'Regular expression literal must start with a slash');
        str = source[index++];

        classMarker = false;
        terminated = false;
        while (index < length) {
            ch = source[index++];
            str += ch;
            if (ch === '\\') {
                ch = source[index++];
                // ECMA-262 7.8.5
                if (isLineTerminator(ch.charCodeAt(0))) {
                    throwUnexpectedToken(null, Messages.UnterminatedRegExp);
                }
                str += ch;
            } else if (isLineTerminator(ch.charCodeAt(0))) {
                throwUnexpectedToken(null, Messages.UnterminatedRegExp);
            } else if (classMarker) {
                if (ch === ']') {
                    classMarker = false;
                }
            } else {
                if (ch === '/') {
                    terminated = true;
                    break;
                } else if (ch === '[') {
                    classMarker = true;
                }
            }
        }

        if (!terminated) {
            throwUnexpectedToken(null, Messages.UnterminatedRegExp);
        }

        // Exclude leading and trailing slash.
        body = str.substr(1, str.length - 2);
        return {
            value: body,
            literal: str
        };
    }

    function scanRegExpFlags() {
        var ch, str, flags, restore;

        str = '';
        flags = '';
        while (index < length) {
            ch = source[index];
            if (!isIdentifierPart(ch.charCodeAt(0))) {
                break;
            }

            ++index;
            if (ch === '\\' && index < length) {
                ch = source[index];
                if (ch === 'u') {
                    ++index;
                    restore = index;
                    ch = scanHexEscape('u');
                    if (ch) {
                        flags += ch;
                        for (str += '\\u'; restore < index; ++restore) {
                            str += source[restore];
                        }
                    } else {
                        index = restore;
                        flags += 'u';
                        str += '\\u';
                    }
                    tolerateUnexpectedToken();
                } else {
                    str += '\\';
                    tolerateUnexpectedToken();
                }
            } else {
                flags += ch;
                str += ch;
            }
        }

        return {
            value: flags,
            literal: str
        };
    }

    function scanRegExp() {
        var start, body, flags, value;
        scanning = true;

        lookahead = null;
        skipComment();
        start = index;

        body = scanRegExpBody();
        flags = scanRegExpFlags();
        value = testRegExp(body.value, flags.value);
        scanning = false;
        if (extra.tokenize) {
            return {
                type: Token.RegularExpression,
                value: value,
                regex: {
                    pattern: body.value,
                    flags: flags.value
                },
                lineNumber: lineNumber,
                lineStart: lineStart,
                start: start,
                end: index
            };
        }

        return {
            literal: body.literal + flags.literal,
            value: value,
            regex: {
                pattern: body.value,
                flags: flags.value
            },
            start: start,
            end: index
        };
    }

    function collectRegex() {
        var pos, loc, regex, token;

        skipComment();

        pos = index;
        loc = {
            start: {
                line: lineNumber,
                column: index - lineStart
            }
        };

        regex = scanRegExp();

        loc.end = {
            line: lineNumber,
            column: index - lineStart
        };

        /* istanbul ignore next */
        if (!extra.tokenize) {
            // Pop the previous token, which is likely '/' or '/='
            if (extra.tokens.length > 0) {
                token = extra.tokens[extra.tokens.length - 1];
                if (token.range[0] === pos && token.type === 'Punctuator') {
                    if (token.value === '/' || token.value === '/=') {
                        extra.tokens.pop();
                    }
                }
            }

            extra.tokens.push({
                type: 'RegularExpression',
                value: regex.literal,
                regex: regex.regex,
                range: [pos, index],
                loc: loc
            });
        }

        return regex;
    }

    function isIdentifierName(token) {
        return token.type === Token.Identifier ||
            token.type === Token.Keyword ||
            token.type === Token.BooleanLiteral ||
            token.type === Token.NullLiteral;
    }

    // Using the following algorithm:
    // https://github.com/mozilla/sweet.js/wiki/design

    function advanceSlash() {
        var regex, previous, check;

        function testKeyword(value) {
            return value && (value.length > 1) && (value[0] >= 'a') && (value[0] <= 'z');
        }

        previous = extra.tokenValues[extra.tokens.length - 1];
        regex = (previous !== null);

        switch (previous) {
        case 'this':
        case ']':
            regex = false;
            break;

        case ')':
            check = extra.tokenValues[extra.openParenToken - 1];
            regex = (check === 'if' || check === 'while' || check === 'for' || check === 'with');
            break;

        case '}':
            // Dividing a function by anything makes little sense,
            // but we have to check for that.
            regex = false;
            if (testKeyword(extra.tokenValues[extra.openCurlyToken - 3])) {
                // Anonymous function, e.g. function(){} /42
                check = extra.tokenValues[extra.openCurlyToken - 4];
                regex = check ? (FnExprTokens.indexOf(check) < 0) : false;
            } else if (testKeyword(extra.tokenValues[extra.openCurlyToken - 4])) {
                // Named function, e.g. function f(){} /42/
                check = extra.tokenValues[extra.openCurlyToken - 5];
                regex = check ? (FnExprTokens.indexOf(check) < 0) : true;
            }
        }

        return regex ? collectRegex() : scanPunctuator();
    }

    function advance() {
        var cp, token;

        if (index >= length) {
            return {
                type: Token.EOF,
                lineNumber: lineNumber,
                lineStart: lineStart,
                start: index,
                end: index
            };
        }

        cp = source.charCodeAt(index);

        if (isIdentifierStart(cp)) {
            token = scanIdentifier();
            if (strict && isStrictModeReservedWord(token.value)) {
                token.type = Token.Keyword;
            }
            return token;
        }

        // Very common: ( and ) and ;
        if (cp === 0x28 || cp === 0x29 || cp === 0x3B) {
            return scanPunctuator();
        }

        // String literal starts with single quote (U+0027) or double quote (U+0022).
        if (cp === 0x27 || cp === 0x22) {
            return scanStringLiteral();
        }

        // Dot (.) U+002E can also start a floating-point number, hence the need
        // to check the next character.
        if (cp === 0x2E) {
            if (isDecimalDigit(source.charCodeAt(index + 1))) {
                return scanNumericLiteral();
            }
            return scanPunctuator();
        }

        if (isDecimalDigit(cp)) {
            return scanNumericLiteral();
        }

        // Slash (/) U+002F can also start a regex.
        if (extra.tokenize && cp === 0x2F) {
            return advanceSlash();
        }

        // Template literals start with ` (U+0060) for template head
        // or } (U+007D) for template middle or template tail.
        if (cp === 0x60 || (cp === 0x7D && state.curlyStack[state.curlyStack.length - 1] === '${')) {
            return scanTemplate();
        }

        // Possible identifier start in a surrogate pair.
        if (cp >= 0xD800 && cp < 0xDFFF) {
            cp = codePointAt(index);
            if (isIdentifierStart(cp)) {
                return scanIdentifier();
            }
        }

        return scanPunctuator();
    }

    function collectToken() {
        var loc, token, value, entry;

        loc = {
            start: {
                line: lineNumber,
                column: index - lineStart
            }
        };

        token = advance();
        loc.end = {
            line: lineNumber,
            column: index - lineStart
        };

        if (token.type !== Token.EOF) {
            value = source.slice(token.start, token.end);
            entry = {
                type: TokenName[token.type],
                value: value,
                range: [token.start, token.end],
                loc: loc
            };
            if (token.regex) {
                entry.regex = {
                    pattern: token.regex.pattern,
                    flags: token.regex.flags
                };
            }
            if (extra.tokenValues) {
                extra.tokenValues.push((entry.type === 'Punctuator' || entry.type === 'Keyword') ? entry.value : null);
            }
            if (extra.tokenize) {
                if (!extra.range) {
                    delete entry.range;
                }
                if (!extra.loc) {
                    delete entry.loc;
                }
                if (extra.delegate) {
                    entry = extra.delegate(entry);
                }
            }
            extra.tokens.push(entry);
        }

        return token;
    }

    function lex() {
        var token;
        scanning = true;

        lastIndex = index;
        lastLineNumber = lineNumber;
        lastLineStart = lineStart;

        skipComment();

        token = lookahead;

        startIndex = index;
        startLineNumber = lineNumber;
        startLineStart = lineStart;

        lookahead = (typeof extra.tokens !== 'undefined') ? collectToken() : advance();
        scanning = false;
        return token;
    }

    function peek() {
        scanning = true;

        skipComment();

        lastIndex = index;
        lastLineNumber = lineNumber;
        lastLineStart = lineStart;

        startIndex = index;
        startLineNumber = lineNumber;
        startLineStart = lineStart;

        lookahead = (typeof extra.tokens !== 'undefined') ? collectToken() : advance();
        scanning = false;
    }

    function Position() {
        this.line = startLineNumber;
        this.column = startIndex - startLineStart;
    }

    function SourceLocation() {
        this.start = new Position();
        this.end = null;
    }

    function WrappingSourceLocation(startToken) {
        this.start = {
            line: startToken.lineNumber,
            column: startToken.start - startToken.lineStart
        };
        this.end = null;
    }

    function Node() {
        if (extra.range) {
            this.range = [startIndex, 0];
        }
        if (extra.loc) {
            this.loc = new SourceLocation();
        }
    }

    function WrappingNode(startToken) {
        if (extra.range) {
            this.range = [startToken.start, 0];
        }
        if (extra.loc) {
            this.loc = new WrappingSourceLocation(startToken);
        }
    }

    WrappingNode.prototype = Node.prototype = {

        processComment: function () {
            var lastChild,
                innerComments,
                leadingComments,
                trailingComments,
                bottomRight = extra.bottomRightStack,
                i,
                comment,
                last = bottomRight[bottomRight.length - 1];

            if (this.type === Syntax.Program) {
                if (this.body.length > 0) {
                    return;
                }
            }
            /**
             * patch innnerComments for properties empty block
             * `function a() {/** comments **\/}`
             */

            if (this.type === Syntax.BlockStatement && this.body.length === 0) {
                innerComments = [];
                for (i = extra.leadingComments.length - 1; i >= 0; --i) {
                    comment = extra.leadingComments[i];
                    if (this.range[1] >= comment.range[1]) {
                        innerComments.unshift(comment);
                        extra.leadingComments.splice(i, 1);
                        extra.trailingComments.splice(i, 1);
                    }
                }
                if (innerComments.length) {
                    this.innerComments = innerComments;
                    //bottomRight.push(this);
                    return;
                }
            }

            if (extra.trailingComments.length > 0) {
                trailingComments = [];
                for (i = extra.trailingComments.length - 1; i >= 0; --i) {
                    comment = extra.trailingComments[i];
                    if (comment.range[0] >= this.range[1]) {
                        trailingComments.unshift(comment);
                        extra.trailingComments.splice(i, 1);
                    }
                }
                extra.trailingComments = [];
            } else {
                if (last && last.trailingComments && last.trailingComments[0].range[0] >= this.range[1]) {
                    trailingComments = last.trailingComments;
                    delete last.trailingComments;
                }
            }

            // Eating the stack.
            while (last && last.range[0] >= this.range[0]) {
                lastChild = bottomRight.pop();
                last = bottomRight[bottomRight.length - 1];
            }

            if (lastChild) {
                if (lastChild.leadingComments) {
                    leadingComments = [];
                    for (i = lastChild.leadingComments.length - 1; i >= 0; --i) {
                        comment = lastChild.leadingComments[i];
                        if (comment.range[1] <= this.range[0]) {
                            leadingComments.unshift(comment);
                            lastChild.leadingComments.splice(i, 1);
                        }
                    }

                    if (!lastChild.leadingComments.length) {
                        lastChild.leadingComments = undefined;
                    }
                }
            } else if (extra.leadingComments.length > 0) {
                leadingComments = [];
                for (i = extra.leadingComments.length - 1; i >= 0; --i) {
                    comment = extra.leadingComments[i];
                    if (comment.range[1] <= this.range[0]) {
                        leadingComments.unshift(comment);
                        extra.leadingComments.splice(i, 1);
                    }
                }
            }


            if (leadingComments && leadingComments.length > 0) {
                this.leadingComments = leadingComments;
            }
            if (trailingComments && trailingComments.length > 0) {
                this.trailingComments = trailingComments;
            }

            bottomRight.push(this);
        },

        finish: function () {
            if (extra.range) {
                this.range[1] = lastIndex;
            }
            if (extra.loc) {
                this.loc.end = {
                    line: lastLineNumber,
                    column: lastIndex - lastLineStart
                };
                if (extra.source) {
                    this.loc.source = extra.source;
                }
            }

            if (extra.attachComment) {
                this.processComment();
            }
        },

        finishArrayExpression: function (elements) {
            this.type = Syntax.ArrayExpression;
            this.elements = elements;
            this.finish();
            return this;
        },

        finishArrayPattern: function (elements) {
            this.type = Syntax.ArrayPattern;
            this.elements = elements;
            this.finish();
            return this;
        },

        finishArrowFunctionExpression: function (params, defaults, body, expression) {
            this.type = Syntax.ArrowFunctionExpression;
            this.id = null;
            this.params = params;
            this.defaults = defaults;
            this.body = body;
            this.generator = false;
            this.expression = expression;
            this.finish();
            return this;
        },

        finishAssignmentExpression: function (operator, left, right) {
            this.type = Syntax.AssignmentExpression;
            this.operator = operator;
            this.left = left;
            this.right = right;
            this.finish();
            return this;
        },

        finishAssignmentPattern: function (left, right) {
            this.type = Syntax.AssignmentPattern;
            this.left = left;
            this.right = right;
            this.finish();
            return this;
        },

        finishBinaryExpression: function (operator, left, right) {
            this.type = (operator === '||' || operator === '&&') ? Syntax.LogicalExpression : Syntax.BinaryExpression;
            this.operator = operator;
            this.left = left;
            this.right = right;
            this.finish();
            return this;
        },

        finishBlockStatement: function (body) {
            this.type = Syntax.BlockStatement;
            this.body = body;
            this.finish();
            return this;
        },

        finishBreakStatement: function (label) {
            this.type = Syntax.BreakStatement;
            this.label = label;
            this.finish();
            return this;
        },

        finishCallExpression: function (callee, args) {
            this.type = Syntax.CallExpression;
            this.callee = callee;
            this.arguments = args;
            this.finish();
            return this;
        },

        finishCatchClause: function (param, body) {
            this.type = Syntax.CatchClause;
            this.param = param;
            this.body = body;
            this.finish();
            return this;
        },

        finishClassBody: function (body) {
            this.type = Syntax.ClassBody;
            this.body = body;
            this.finish();
            return this;
        },

        finishClassDeclaration: function (id, superClass, body) {
            this.type = Syntax.ClassDeclaration;
            this.id = id;
            this.superClass = superClass;
            this.body = body;
            this.finish();
            return this;
        },

        finishClassExpression: function (id, superClass, body) {
            this.type = Syntax.ClassExpression;
            this.id = id;
            this.superClass = superClass;
            this.body = body;
            this.finish();
            return this;
        },

        finishConditionalExpression: function (test, consequent, alternate) {
            this.type = Syntax.ConditionalExpression;
            this.test = test;
            this.consequent = consequent;
            this.alternate = alternate;
            this.finish();
            return this;
        },

        finishContinueStatement: function (label) {
            this.type = Syntax.ContinueStatement;
            this.label = label;
            this.finish();
            return this;
        },

        finishDebuggerStatement: function () {
            this.type = Syntax.DebuggerStatement;
            this.finish();
            return this;
        },

        finishDoWhileStatement: function (body, test) {
            this.type = Syntax.DoWhileStatement;
            this.body = body;
            this.test = test;
            this.finish();
            return this;
        },

        finishEmptyStatement: function () {
            this.type = Syntax.EmptyStatement;
            this.finish();
            return this;
        },

        finishExpressionStatement: function (expression) {
            this.type = Syntax.ExpressionStatement;
            this.expression = expression;
            this.finish();
            return this;
        },

        finishForStatement: function (init, test, update, body) {
            this.type = Syntax.ForStatement;
            this.init = init;
            this.test = test;
            this.update = update;
            this.body = body;
            this.finish();
            return this;
        },

        finishForOfStatement: function (left, right, body) {
            this.type = Syntax.ForOfStatement;
            this.left = left;
            this.right = right;
            this.body = body;
            this.finish();
            return this;
        },

        finishForInStatement: function (left, right, body) {
            this.type = Syntax.ForInStatement;
            this.left = left;
            this.right = right;
            this.body = body;
            this.each = false;
            this.finish();
            return this;
        },

        finishFunctionDeclaration: function (id, params, defaults, body, generator) {
            this.type = Syntax.FunctionDeclaration;
            this.id = id;
            this.params = params;
            this.defaults = defaults;
            this.body = body;
            this.generator = generator;
            this.expression = false;
            this.finish();
            return this;
        },

        finishFunctionExpression: function (id, params, defaults, body, generator) {
            this.type = Syntax.FunctionExpression;
            this.id = id;
            this.params = params;
            this.defaults = defaults;
            this.body = body;
            this.generator = generator;
            this.expression = false;
            this.finish();
            return this;
        },

        finishIdentifier: function (name) {
            this.type = Syntax.Identifier;
            this.name = name;
            this.finish();
            return this;
        },

        finishIfStatement: function (test, consequent, alternate) {
            this.type = Syntax.IfStatement;
            this.test = test;
            this.consequent = consequent;
            this.alternate = alternate;
            this.finish();
            return this;
        },

        finishLabeledStatement: function (label, body) {
            this.type = Syntax.LabeledStatement;
            this.label = label;
            this.body = body;
            this.finish();
            return this;
        },

        finishLiteral: function (token) {
            this.type = Syntax.Literal;
            this.value = token.value;
            this.raw = source.slice(token.start, token.end);
            if (token.regex) {
                this.regex = token.regex;
            }
            this.finish();
            return this;
        },

        finishMemberExpression: function (accessor, object, property) {
            this.type = Syntax.MemberExpression;
            this.computed = accessor === '[';
            this.object = object;
            this.property = property;
            this.finish();
            return this;
        },

        finishMetaProperty: function (meta, property) {
            this.type = Syntax.MetaProperty;
            this.meta = meta;
            this.property = property;
            this.finish();
            return this;
        },

        finishNewExpression: function (callee, args) {
            this.type = Syntax.NewExpression;
            this.callee = callee;
            this.arguments = args;
            this.finish();
            return this;
        },

        finishObjectExpression: function (properties) {
            this.type = Syntax.ObjectExpression;
            this.properties = properties;
            this.finish();
            return this;
        },

        finishObjectPattern: function (properties) {
            this.type = Syntax.ObjectPattern;
            this.properties = properties;
            this.finish();
            return this;
        },

        finishPostfixExpression: function (operator, argument) {
            this.type = Syntax.UpdateExpression;
            this.operator = operator;
            this.argument = argument;
            this.prefix = false;
            this.finish();
            return this;
        },

        finishProgram: function (body, sourceType) {
            this.type = Syntax.Program;
            this.body = body;
            this.sourceType = sourceType;
            this.finish();
            return this;
        },

        finishProperty: function (kind, key, computed, value, method, shorthand) {
            this.type = Syntax.Property;
            this.key = key;
            this.computed = computed;
            this.value = value;
            this.kind = kind;
            this.method = method;
            this.shorthand = shorthand;
            this.finish();
            return this;
        },

        finishRestElement: function (argument) {
            this.type = Syntax.RestElement;
            this.argument = argument;
            this.finish();
            return this;
        },

        finishReturnStatement: function (argument) {
            this.type = Syntax.ReturnStatement;
            this.argument = argument;
            this.finish();
            return this;
        },

        finishSequenceExpression: function (expressions) {
            this.type = Syntax.SequenceExpression;
            this.expressions = expressions;
            this.finish();
            return this;
        },

        finishSpreadElement: function (argument) {
            this.type = Syntax.SpreadElement;
            this.argument = argument;
            this.finish();
            return this;
        },

        finishSwitchCase: function (test, consequent) {
            this.type = Syntax.SwitchCase;
            this.test = test;
            this.consequent = consequent;
            this.finish();
            return this;
        },

        finishSuper: function () {
            this.type = Syntax.Super;
            this.finish();
            return this;
        },

        finishSwitchStatement: function (discriminant, cases) {
            this.type = Syntax.SwitchStatement;
            this.discriminant = discriminant;
            this.cases = cases;
            this.finish();
            return this;
        },

        finishTaggedTemplateExpression: function (tag, quasi) {
            this.type = Syntax.TaggedTemplateExpression;
            this.tag = tag;
            this.quasi = quasi;
            this.finish();
            return this;
        },

        finishTemplateElement: function (value, tail) {
            this.type = Syntax.TemplateElement;
            this.value = value;
            this.tail = tail;
            this.finish();
            return this;
        },

        finishTemplateLiteral: function (quasis, expressions) {
            this.type = Syntax.TemplateLiteral;
            this.quasis = quasis;
            this.expressions = expressions;
            this.finish();
            return this;
        },

        finishThisExpression: function () {
            this.type = Syntax.ThisExpression;
            this.finish();
            return this;
        },

        finishThrowStatement: function (argument) {
            this.type = Syntax.ThrowStatement;
            this.argument = argument;
            this.finish();
            return this;
        },

        finishTryStatement: function (block, handler, finalizer) {
            this.type = Syntax.TryStatement;
            this.block = block;
            this.guardedHandlers = [];
            this.handlers = handler ? [handler] : [];
            this.handler = handler;
            this.finalizer = finalizer;
            this.finish();
            return this;
        },

        finishUnaryExpression: function (operator, argument) {
            this.type = (operator === '++' || operator === '--') ? Syntax.UpdateExpression : Syntax.UnaryExpression;
            this.operator = operator;
            this.argument = argument;
            this.prefix = true;
            this.finish();
            return this;
        },

        finishVariableDeclaration: function (declarations) {
            this.type = Syntax.VariableDeclaration;
            this.declarations = declarations;
            this.kind = 'var';
            this.finish();
            return this;
        },

        finishLexicalDeclaration: function (declarations, kind) {
            this.type = Syntax.VariableDeclaration;
            this.declarations = declarations;
            this.kind = kind;
            this.finish();
            return this;
        },

        finishVariableDeclarator: function (id, init) {
            this.type = Syntax.VariableDeclarator;
            this.id = id;
            this.init = init;
            this.finish();
            return this;
        },

        finishWhileStatement: function (test, body) {
            this.type = Syntax.WhileStatement;
            this.test = test;
            this.body = body;
            this.finish();
            return this;
        },

        finishWithStatement: function (object, body) {
            this.type = Syntax.WithStatement;
            this.object = object;
            this.body = body;
            this.finish();
            return this;
        },

        finishExportSpecifier: function (local, exported) {
            this.type = Syntax.ExportSpecifier;
            this.exported = exported || local;
            this.local = local;
            this.finish();
            return this;
        },

        finishImportDefaultSpecifier: function (local) {
            this.type = Syntax.ImportDefaultSpecifier;
            this.local = local;
            this.finish();
            return this;
        },

        finishImportNamespaceSpecifier: function (local) {
            this.type = Syntax.ImportNamespaceSpecifier;
            this.local = local;
            this.finish();
            return this;
        },

        finishExportNamedDeclaration: function (declaration, specifiers, src) {
            this.type = Syntax.ExportNamedDeclaration;
            this.declaration = declaration;
            this.specifiers = specifiers;
            this.source = src;
            this.finish();
            return this;
        },

        finishExportDefaultDeclaration: function (declaration) {
            this.type = Syntax.ExportDefaultDeclaration;
            this.declaration = declaration;
            this.finish();
            return this;
        },

        finishExportAllDeclaration: function (src) {
            this.type = Syntax.ExportAllDeclaration;
            this.source = src;
            this.finish();
            return this;
        },

        finishImportSpecifier: function (local, imported) {
            this.type = Syntax.ImportSpecifier;
            this.local = local || imported;
            this.imported = imported;
            this.finish();
            return this;
        },

        finishImportDeclaration: function (specifiers, src) {
            this.type = Syntax.ImportDeclaration;
            this.specifiers = specifiers;
            this.source = src;
            this.finish();
            return this;
        },

        finishYieldExpression: function (argument, delegate) {
            this.type = Syntax.YieldExpression;
            this.argument = argument;
            this.delegate = delegate;
            this.finish();
            return this;
        }
    };


    function recordError(error) {
        var e, existing;

        for (e = 0; e < extra.errors.length; e++) {
            existing = extra.errors[e];
            // Prevent duplicated error.
            /* istanbul ignore next */
            if (existing.index === error.index && existing.message === error.message) {
                return;
            }
        }

        extra.errors.push(error);
    }

    function constructError(msg, column) {
        var error = new Error(msg);
        try {
            throw error;
        } catch (base) {
            /* istanbul ignore else */
            if (Object.create && Object.defineProperty) {
                error = Object.create(base);
                Object.defineProperty(error, 'column', { value: column });
            }
        } finally {
            return error;
        }
    }

    function createError(line, pos, description) {
        var msg, column, error;

        msg = 'Line ' + line + ': ' + description;
        column = pos - (scanning ? lineStart : lastLineStart) + 1;
        error = constructError(msg, column);
        error.lineNumber = line;
        error.description = description;
        error.index = pos;
        return error;
    }

    // Throw an exception

    function throwError(messageFormat) {
        var args, msg;

        args = Array.prototype.slice.call(arguments, 1);
        msg = messageFormat.replace(/%(\d)/g,
            function (whole, idx) {
                assert(idx < args.length, 'Message reference must be in range');
                return args[idx];
            }
        );

        throw createError(lastLineNumber, lastIndex, msg);
    }

    function tolerateError(messageFormat) {
        var args, msg, error;

        args = Array.prototype.slice.call(arguments, 1);
        /* istanbul ignore next */
        msg = messageFormat.replace(/%(\d)/g,
            function (whole, idx) {
                assert(idx < args.length, 'Message reference must be in range');
                return args[idx];
            }
        );

        error = createError(lineNumber, lastIndex, msg);
        if (extra.errors) {
            recordError(error);
        } else {
            throw error;
        }
    }

    // Throw an exception because of the token.

    function unexpectedTokenError(token, message) {
        var value, msg = message || Messages.UnexpectedToken;

        if (token) {
            if (!message) {
                msg = (token.type === Token.EOF) ? Messages.UnexpectedEOS :
                    (token.type === Token.Identifier) ? Messages.UnexpectedIdentifier :
                    (token.type === Token.NumericLiteral) ? Messages.UnexpectedNumber :
                    (token.type === Token.StringLiteral) ? Messages.UnexpectedString :
                    (token.type === Token.Template) ? Messages.UnexpectedTemplate :
                    Messages.UnexpectedToken;

                if (token.type === Token.Keyword) {
                    if (isFutureReservedWord(token.value)) {
                        msg = Messages.UnexpectedReserved;
                    } else if (strict && isStrictModeReservedWord(token.value)) {
                        msg = Messages.StrictReservedWord;
                    }
                }
            }

            value = (token.type === Token.Template) ? token.value.raw : token.value;
        } else {
            value = 'ILLEGAL';
        }

        msg = msg.replace('%0', value);

        return (token && typeof token.lineNumber === 'number') ?
            createError(token.lineNumber, token.start, msg) :
            createError(scanning ? lineNumber : lastLineNumber, scanning ? index : lastIndex, msg);
    }

    function throwUnexpectedToken(token, message) {
        throw unexpectedTokenError(token, message);
    }

    function tolerateUnexpectedToken(token, message) {
        var error = unexpectedTokenError(token, message);
        if (extra.errors) {
            recordError(error);
        } else {
            throw error;
        }
    }

    // Expect the next token to match the specified punctuator.
    // If not, an exception will be thrown.

    function expect(value) {
        var token = lex();
        if (token.type !== Token.Punctuator || token.value !== value) {
            throwUnexpectedToken(token);
        }
    }

    /**
     * @name expectCommaSeparator
     * @description Quietly expect a comma when in tolerant mode, otherwise delegates
     * to <code>expect(value)</code>
     * @since 2.0
     */
    function expectCommaSeparator() {
        var token;

        if (extra.errors) {
            token = lookahead;
            if (token.type === Token.Punctuator && token.value === ',') {
                lex();
            } else if (token.type === Token.Punctuator && token.value === ';') {
                lex();
                tolerateUnexpectedToken(token);
            } else {
                tolerateUnexpectedToken(token, Messages.UnexpectedToken);
            }
        } else {
            expect(',');
        }
    }

    // Expect the next token to match the specified keyword.
    // If not, an exception will be thrown.

    function expectKeyword(keyword) {
        var token = lex();
        if (token.type !== Token.Keyword || token.value !== keyword) {
            throwUnexpectedToken(token);
        }
    }

    // Return true if the next token matches the specified punctuator.

    function match(value) {
        return lookahead.type === Token.Punctuator && lookahead.value === value;
    }

    // Return true if the next token matches the specified keyword

    function matchKeyword(keyword) {
        return lookahead.type === Token.Keyword && lookahead.value === keyword;
    }

    // Return true if the next token matches the specified contextual keyword
    // (where an identifier is sometimes a keyword depending on the context)

    function matchContextualKeyword(keyword) {
        return lookahead.type === Token.Identifier && lookahead.value === keyword;
    }

    // Return true if the next token is an assignment operator

    function matchAssign() {
        var op;

        if (lookahead.type !== Token.Punctuator) {
            return false;
        }
        op = lookahead.value;
        return op === '=' ||
            op === '*=' ||
            op === '/=' ||
            op === '%=' ||
            op === '+=' ||
            op === '-=' ||
            op === '<<=' ||
            op === '>>=' ||
            op === '>>>=' ||
            op === '&=' ||
            op === '^=' ||
            op === '|=';
    }

    function consumeSemicolon() {
        // Catch the very common case first: immediately a semicolon (U+003B).
        if (source.charCodeAt(startIndex) === 0x3B || match(';')) {
            lex();
            return;
        }

        if (hasLineTerminator) {
            return;
        }

        // FIXME(ikarienator): this is seemingly an issue in the previous location info convention.
        lastIndex = startIndex;
        lastLineNumber = startLineNumber;
        lastLineStart = startLineStart;

        if (lookahead.type !== Token.EOF && !match('}')) {
            throwUnexpectedToken(lookahead);
        }
    }

    // Cover grammar support.
    //
    // When an assignment expression position starts with an left parenthesis, the determination of the type
    // of the syntax is to be deferred arbitrarily long until the end of the parentheses pair (plus a lookahead)
    // or the first comma. This situation also defers the determination of all the expressions nested in the pair.
    //
    // There are three productions that can be parsed in a parentheses pair that needs to be determined
    // after the outermost pair is closed. They are:
    //
    //   1. AssignmentExpression
    //   2. BindingElements
    //   3. AssignmentTargets
    //
    // In order to avoid exponential backtracking, we use two flags to denote if the production can be
    // binding element or assignment target.
    //
    // The three productions have the relationship:
    //
    //   BindingElements ⊆ AssignmentTargets ⊆ AssignmentExpression
    //
    // with a single exception that CoverInitializedName when used directly in an Expression, generates
    // an early error. Therefore, we need the third state, firstCoverInitializedNameError, to track the
    // first usage of CoverInitializedName and report it when we reached the end of the parentheses pair.
    //
    // isolateCoverGrammar function runs the given parser function with a new cover grammar context, and it does not
    // effect the current flags. This means the production the parser parses is only used as an expression. Therefore
    // the CoverInitializedName check is conducted.
    //
    // inheritCoverGrammar function runs the given parse function with a new cover grammar context, and it propagates
    // the flags outside of the parser. This means the production the parser parses is used as a part of a potential
    // pattern. The CoverInitializedName check is deferred.
    function isolateCoverGrammar(parser) {
        var oldIsBindingElement = isBindingElement,
            oldIsAssignmentTarget = isAssignmentTarget,
            oldFirstCoverInitializedNameError = firstCoverInitializedNameError,
            result;
        isBindingElement = true;
        isAssignmentTarget = true;
        firstCoverInitializedNameError = null;
        result = parser();
        if (firstCoverInitializedNameError !== null) {
            throwUnexpectedToken(firstCoverInitializedNameError);
        }
        isBindingElement = oldIsBindingElement;
        isAssignmentTarget = oldIsAssignmentTarget;
        firstCoverInitializedNameError = oldFirstCoverInitializedNameError;
        return result;
    }

    function inheritCoverGrammar(parser) {
        var oldIsBindingElement = isBindingElement,
            oldIsAssignmentTarget = isAssignmentTarget,
            oldFirstCoverInitializedNameError = firstCoverInitializedNameError,
            result;
        isBindingElement = true;
        isAssignmentTarget = true;
        firstCoverInitializedNameError = null;
        result = parser();
        isBindingElement = isBindingElement && oldIsBindingElement;
        isAssignmentTarget = isAssignmentTarget && oldIsAssignmentTarget;
        firstCoverInitializedNameError = oldFirstCoverInitializedNameError || firstCoverInitializedNameError;
        return result;
    }

    // ECMA-262 13.3.3 Destructuring Binding Patterns

    function parseArrayPattern(params, kind) {
        var node = new Node(), elements = [], rest, restNode;
        expect('[');

        while (!match(']')) {
            if (match(',')) {
                lex();
                elements.push(null);
            } else {
                if (match('...')) {
                    restNode = new Node();
                    lex();
                    params.push(lookahead);
                    rest = parseVariableIdentifier(kind);
                    elements.push(restNode.finishRestElement(rest));
                    break;
                } else {
                    elements.push(parsePatternWithDefault(params, kind));
                }
                if (!match(']')) {
                    expect(',');
                }
            }

        }

        expect(']');

        return node.finishArrayPattern(elements);
    }

    function parsePropertyPattern(params, kind) {
        var node = new Node(), key, keyToken, computed = match('['), init;
        if (lookahead.type === Token.Identifier) {
            keyToken = lookahead;
            key = parseVariableIdentifier();
            if (match('=')) {
                params.push(keyToken);
                lex();
                init = parseAssignmentExpression();

                return node.finishProperty(
                    'init', key, false,
                    new WrappingNode(keyToken).finishAssignmentPattern(key, init), false, true);
            } else if (!match(':')) {
                params.push(keyToken);
                return node.finishProperty('init', key, false, key, false, true);
            }
        } else {
            key = parseObjectPropertyKey();
        }
        expect(':');
        init = parsePatternWithDefault(params, kind);
        return node.finishProperty('init', key, computed, init, false, false);
    }

    function parseObjectPattern(params, kind) {
        var node = new Node(), properties = [];

        expect('{');

        while (!match('}')) {
            properties.push(parsePropertyPattern(params, kind));
            if (!match('}')) {
                expect(',');
            }
        }

        lex();

        return node.finishObjectPattern(properties);
    }

    function parsePattern(params, kind) {
        if (match('[')) {
            return parseArrayPattern(params, kind);
        } else if (match('{')) {
            return parseObjectPattern(params, kind);
        } else if (matchKeyword('let')) {
            if (kind === 'const' || kind === 'let') {
                tolerateUnexpectedToken(lookahead, Messages.UnexpectedToken);
            }
        }

        params.push(lookahead);
        return parseVariableIdentifier(kind);
    }

    function parsePatternWithDefault(params, kind) {
        var startToken = lookahead, pattern, previousAllowYield, right;
        pattern = parsePattern(params, kind);
        if (match('=')) {
            lex();
            previousAllowYield = state.allowYield;
            state.allowYield = true;
            right = isolateCoverGrammar(parseAssignmentExpression);
            state.allowYield = previousAllowYield;
            pattern = new WrappingNode(startToken).finishAssignmentPattern(pattern, right);
        }
        return pattern;
    }

    // ECMA-262 12.2.5 Array Initializer

    function parseArrayInitializer() {
        var elements = [], node = new Node(), restSpread;

        expect('[');

        while (!match(']')) {
            if (match(',')) {
                lex();
                elements.push(null);
            } else if (match('...')) {
                restSpread = new Node();
                lex();
                restSpread.finishSpreadElement(inheritCoverGrammar(parseAssignmentExpression));

                if (!match(']')) {
                    isAssignmentTarget = isBindingElement = false;
                    expect(',');
                }
                elements.push(restSpread);
            } else {
                elements.push(inheritCoverGrammar(parseAssignmentExpression));

                if (!match(']')) {
                    expect(',');
                }
            }
        }

        lex();

        return node.finishArrayExpression(elements);
    }

    // ECMA-262 12.2.6 Object Initializer

    function parsePropertyFunction(node, paramInfo, isGenerator) {
        var previousStrict, body;

        isAssignmentTarget = isBindingElement = false;

        previousStrict = strict;
        body = isolateCoverGrammar(parseFunctionSourceElements);

        if (strict && paramInfo.firstRestricted) {
            tolerateUnexpectedToken(paramInfo.firstRestricted, paramInfo.message);
        }
        if (strict && paramInfo.stricted) {
            tolerateUnexpectedToken(paramInfo.stricted, paramInfo.message);
        }

        strict = previousStrict;
        return node.finishFunctionExpression(null, paramInfo.params, paramInfo.defaults, body, isGenerator);
    }

    function parsePropertyMethodFunction() {
        var params, method, node = new Node(),
            previousAllowYield = state.allowYield;

        state.allowYield = false;
        params = parseParams();
        state.allowYield = previousAllowYield;

        state.allowYield = false;
        method = parsePropertyFunction(node, params, false);
        state.allowYield = previousAllowYield;

        return method;
    }

    function parseObjectPropertyKey() {
        var token, node = new Node(), expr;

        token = lex();

        // Note: This function is called only from parseObjectProperty(), where
        // EOF and Punctuator tokens are already filtered out.

        switch (token.type) {
        case Token.StringLiteral:
        case Token.NumericLiteral:
            if (strict && token.octal) {
                tolerateUnexpectedToken(token, Messages.StrictOctalLiteral);
            }
            return node.finishLiteral(token);
        case Token.Identifier:
        case Token.BooleanLiteral:
        case Token.NullLiteral:
        case Token.Keyword:
            return node.finishIdentifier(token.value);
        case Token.Punctuator:
            if (token.value === '[') {
                expr = isolateCoverGrammar(parseAssignmentExpression);
                expect(']');
                return expr;
            }
            break;
        }
        throwUnexpectedToken(token);
    }

    function lookaheadPropertyName() {
        switch (lookahead.type) {
        case Token.Identifier:
        case Token.StringLiteral:
        case Token.BooleanLiteral:
        case Token.NullLiteral:
        case Token.NumericLiteral:
        case Token.Keyword:
            return true;
        case Token.Punctuator:
            return lookahead.value === '[';
        }
        return false;
    }

    // This function is to try to parse a MethodDefinition as defined in 14.3. But in the case of object literals,
    // it might be called at a position where there is in fact a short hand identifier pattern or a data property.
    // This can only be determined after we consumed up to the left parentheses.
    //
    // In order to avoid back tracking, it returns `null` if the position is not a MethodDefinition and the caller
    // is responsible to visit other options.
    function tryParseMethodDefinition(token, key, computed, node) {
        var value, options, methodNode, params,
            previousAllowYield = state.allowYield;

        if (token.type === Token.Identifier) {
            // check for `get` and `set`;

            if (token.value === 'get' && lookaheadPropertyName()) {
                computed = match('[');
                key = parseObjectPropertyKey();
                methodNode = new Node();
                expect('(');
                expect(')');

                state.allowYield = false;
                value = parsePropertyFunction(methodNode, {
                    params: [],
                    defaults: [],
                    stricted: null,
                    firstRestricted: null,
                    message: null
                }, false);
                state.allowYield = previousAllowYield;

                return node.finishProperty('get', key, computed, value, false, false);
            } else if (token.value === 'set' && lookaheadPropertyName()) {
                computed = match('[');
                key = parseObjectPropertyKey();
                methodNode = new Node();
                expect('(');

                options = {
                    params: [],
                    defaultCount: 0,
                    defaults: [],
                    firstRestricted: null,
                    paramSet: {}
                };
                if (match(')')) {
                    tolerateUnexpectedToken(lookahead);
                } else {
                    state.allowYield = false;
                    parseParam(options);
                    state.allowYield = previousAllowYield;
                    if (options.defaultCount === 0) {
                        options.defaults = [];
                    }
                }
                expect(')');

                state.allowYield = false;
                value = parsePropertyFunction(methodNode, options, false);
                state.allowYield = previousAllowYield;

                return node.finishProperty('set', key, computed, value, false, false);
            }
        } else if (token.type === Token.Punctuator && token.value === '*' && lookaheadPropertyName()) {
            computed = match('[');
            key = parseObjectPropertyKey();
            methodNode = new Node();

            state.allowYield = true;
            params = parseParams();
            state.allowYield = previousAllowYield;

            state.allowYield = false;
            value = parsePropertyFunction(methodNode, params, true);
            state.allowYield = previousAllowYield;

            return node.finishProperty('init', key, computed, value, true, false);
        }

        if (key && match('(')) {
            value = parsePropertyMethodFunction();
            return node.finishProperty('init', key, computed, value, true, false);
        }

        // Not a MethodDefinition.
        return null;
    }

    function parseObjectProperty(hasProto) {
        var token = lookahead, node = new Node(), computed, key, maybeMethod, proto, value;

        computed = match('[');
        if (match('*')) {
            lex();
        } else {
            key = parseObjectPropertyKey();
        }
        maybeMethod = tryParseMethodDefinition(token, key, computed, node);
        if (maybeMethod) {
            return maybeMethod;
        }

        if (!key) {
            throwUnexpectedToken(lookahead);
        }

        // Check for duplicated __proto__
        if (!computed) {
            proto = (key.type === Syntax.Identifier && key.name === '__proto__') ||
                (key.type === Syntax.Literal && key.value === '__proto__');
            if (hasProto.value && proto) {
                tolerateError(Messages.DuplicateProtoProperty);
            }
            hasProto.value |= proto;
        }

        if (match(':')) {
            lex();
            value = inheritCoverGrammar(parseAssignmentExpression);
            return node.finishProperty('init', key, computed, value, false, false);
        }

        if (token.type === Token.Identifier) {
            if (match('=')) {
                firstCoverInitializedNameError = lookahead;
                lex();
                value = isolateCoverGrammar(parseAssignmentExpression);
                return node.finishProperty('init', key, computed,
                    new WrappingNode(token).finishAssignmentPattern(key, value), false, true);
            }
            return node.finishProperty('init', key, computed, key, false, true);
        }

        throwUnexpectedToken(lookahead);
    }

    function parseObjectInitializer() {
        var properties = [], hasProto = {value: false}, node = new Node();

        expect('{');

        while (!match('}')) {
            properties.push(parseObjectProperty(hasProto));

            if (!match('}')) {
                expectCommaSeparator();
            }
        }

        expect('}');

        return node.finishObjectExpression(properties);
    }

    function reinterpretExpressionAsPattern(expr) {
        var i;
        switch (expr.type) {
        case Syntax.Identifier:
        case Syntax.MemberExpression:
        case Syntax.RestElement:
        case Syntax.AssignmentPattern:
            break;
        case Syntax.SpreadElement:
            expr.type = Syntax.RestElement;
            reinterpretExpressionAsPattern(expr.argument);
            break;
        case Syntax.ArrayExpression:
            expr.type = Syntax.ArrayPattern;
            for (i = 0; i < expr.elements.length; i++) {
                if (expr.elements[i] !== null) {
                    reinterpretExpressionAsPattern(expr.elements[i]);
                }
            }
            break;
        case Syntax.ObjectExpression:
            expr.type = Syntax.ObjectPattern;
            for (i = 0; i < expr.properties.length; i++) {
                reinterpretExpressionAsPattern(expr.properties[i].value);
            }
            break;
        case Syntax.AssignmentExpression:
            expr.type = Syntax.AssignmentPattern;
            reinterpretExpressionAsPattern(expr.left);
            break;
        default:
            // Allow other node type for tolerant parsing.
            break;
        }
    }

    // ECMA-262 12.2.9 Template Literals

    function parseTemplateElement(option) {
        var node, token;

        if (lookahead.type !== Token.Template || (option.head && !lookahead.head)) {
            throwUnexpectedToken();
        }

        node = new Node();
        token = lex();

        return node.finishTemplateElement({ raw: token.value.raw, cooked: token.value.cooked }, token.tail);
    }

    function parseTemplateLiteral() {
        var quasi, quasis, expressions, node = new Node();

        quasi = parseTemplateElement({ head: true });
        quasis = [quasi];
        expressions = [];

        while (!quasi.tail) {
            expressions.push(parseExpression());
            quasi = parseTemplateElement({ head: false });
            quasis.push(quasi);
        }

        return node.finishTemplateLiteral(quasis, expressions);
    }

    // ECMA-262 12.2.10 The Grouping Operator

    function parseGroupExpression() {
        var expr, expressions, startToken, i, params = [];

        expect('(');

        if (match(')')) {
            lex();
            if (!match('=>')) {
                expect('=>');
            }
            return {
                type: PlaceHolders.ArrowParameterPlaceHolder,
                params: [],
                rawParams: []
            };
        }

        startToken = lookahead;
        if (match('...')) {
            expr = parseRestElement(params);
            expect(')');
            if (!match('=>')) {
                expect('=>');
            }
            return {
                type: PlaceHolders.ArrowParameterPlaceHolder,
                params: [expr]
            };
        }

        isBindingElement = true;
        expr = inheritCoverGrammar(parseAssignmentExpression);

        if (match(',')) {
            isAssignmentTarget = false;
            expressions = [expr];

            while (startIndex < length) {
                if (!match(',')) {
                    break;
                }
                lex();

                if (match('...')) {
                    if (!isBindingElement) {
                        throwUnexpectedToken(lookahead);
                    }
                    expressions.push(parseRestElement(params));
                    expect(')');
                    if (!match('=>')) {
                        expect('=>');
                    }
                    isBindingElement = false;
                    for (i = 0; i < expressions.length; i++) {
                        reinterpretExpressionAsPattern(expressions[i]);
                    }
                    return {
                        type: PlaceHolders.ArrowParameterPlaceHolder,
                        params: expressions
                    };
                }

                expressions.push(inheritCoverGrammar(parseAssignmentExpression));
            }

            expr = new WrappingNode(startToken).finishSequenceExpression(expressions);
        }


        expect(')');

        if (match('=>')) {
            if (expr.type === Syntax.Identifier && expr.name === 'yield') {
                return {
                    type: PlaceHolders.ArrowParameterPlaceHolder,
                    params: [expr]
                };
            }

            if (!isBindingElement) {
                throwUnexpectedToken(lookahead);
            }

            if (expr.type === Syntax.SequenceExpression) {
                for (i = 0; i < expr.expressions.length; i++) {
                    reinterpretExpressionAsPattern(expr.expressions[i]);
                }
            } else {
                reinterpretExpressionAsPattern(expr);
            }

            expr = {
                type: PlaceHolders.ArrowParameterPlaceHolder,
                params: expr.type === Syntax.SequenceExpression ? expr.expressions : [expr]
            };
        }
        isBindingElement = false;
        return expr;
    }


    // ECMA-262 12.2 Primary Expressions

    function parsePrimaryExpression() {
        var type, token, expr, node;

        if (match('(')) {
            isBindingElement = false;
            return inheritCoverGrammar(parseGroupExpression);
        }

        if (match('[')) {
            return inheritCoverGrammar(parseArrayInitializer);
        }

        if (match('{')) {
            return inheritCoverGrammar(parseObjectInitializer);
        }

        type = lookahead.type;
        node = new Node();

        if (type === Token.Identifier) {
            if (state.sourceType === 'module' && lookahead.value === 'await') {
                tolerateUnexpectedToken(lookahead);
            }
            expr = node.finishIdentifier(lex().value);
        } else if (type === Token.StringLiteral || type === Token.NumericLiteral) {
            isAssignmentTarget = isBindingElement = false;
            if (strict && lookahead.octal) {
                tolerateUnexpectedToken(lookahead, Messages.StrictOctalLiteral);
            }
            expr = node.finishLiteral(lex());
        } else if (type === Token.Keyword) {
            if (!strict && state.allowYield && matchKeyword('yield')) {
                return parseNonComputedProperty();
            }
            if (!strict && matchKeyword('let')) {
                return node.finishIdentifier(lex().value);
            }
            isAssignmentTarget = isBindingElement = false;
            if (matchKeyword('function')) {
                return parseFunctionExpression();
            }
            if (matchKeyword('this')) {
                lex();
                return node.finishThisExpression();
            }
            if (matchKeyword('class')) {
                return parseClassExpression();
            }
            throwUnexpectedToken(lex());
        } else if (type === Token.BooleanLiteral) {
            isAssignmentTarget = isBindingElement = false;
            token = lex();
            token.value = (token.value === 'true');
            expr = node.finishLiteral(token);
        } else if (type === Token.NullLiteral) {
            isAssignmentTarget = isBindingElement = false;
            token = lex();
            token.value = null;
            expr = node.finishLiteral(token);
        } else if (match('/') || match('/=')) {
            isAssignmentTarget = isBindingElement = false;
            index = startIndex;

            if (typeof extra.tokens !== 'undefined') {
                token = collectRegex();
            } else {
                token = scanRegExp();
            }
            lex();
            expr = node.finishLiteral(token);
        } else if (type === Token.Template) {
            expr = parseTemplateLiteral();
        } else {
            throwUnexpectedToken(lex());
        }

        return expr;
    }

    // ECMA-262 12.3 Left-Hand-Side Expressions

    function parseArguments() {
        var args = [], expr;

        expect('(');

        if (!match(')')) {
            while (startIndex < length) {
                if (match('...')) {
                    expr = new Node();
                    lex();
                    expr.finishSpreadElement(isolateCoverGrammar(parseAssignmentExpression));
                } else {
                    expr = isolateCoverGrammar(parseAssignmentExpression);
                }
                args.push(expr);
                if (match(')')) {
                    break;
                }
                expectCommaSeparator();
            }
        }

        expect(')');

        return args;
    }

    function parseNonComputedProperty() {
        var token, node = new Node();

        token = lex();

        if (!isIdentifierName(token)) {
            throwUnexpectedToken(token);
        }

        return node.finishIdentifier(token.value);
    }

    function parseNonComputedMember() {
        expect('.');

        return parseNonComputedProperty();
    }

    function parseComputedMember() {
        var expr;

        expect('[');

        expr = isolateCoverGrammar(parseExpression);

        expect(']');

        return expr;
    }

    // ECMA-262 12.3.3 The new Operator

    function parseNewExpression() {
        var callee, args, node = new Node();

        expectKeyword('new');

        if (match('.')) {
            lex();
            if (lookahead.type === Token.Identifier && lookahead.value === 'target') {
                if (state.inFunctionBody) {
                    lex();
                    return node.finishMetaProperty('new', 'target');
                }
            }
            throwUnexpectedToken(lookahead);
        }

        callee = isolateCoverGrammar(parseLeftHandSideExpression);
        args = match('(') ? parseArguments() : [];

        isAssignmentTarget = isBindingElement = false;

        return node.finishNewExpression(callee, args);
    }

    // ECMA-262 12.3.4 Function Calls

    function parseLeftHandSideExpressionAllowCall() {
        var quasi, expr, args, property, startToken, previousAllowIn = state.allowIn;

        startToken = lookahead;
        state.allowIn = true;

        if (matchKeyword('super') && state.inFunctionBody) {
            expr = new Node();
            lex();
            expr = expr.finishSuper();
            if (!match('(') && !match('.') && !match('[')) {
                throwUnexpectedToken(lookahead);
            }
        } else {
            expr = inheritCoverGrammar(matchKeyword('new') ? parseNewExpression : parsePrimaryExpression);
        }

        for (;;) {
            if (match('.')) {
                isBindingElement = false;
                isAssignmentTarget = true;
                property = parseNonComputedMember();
                expr = new WrappingNode(startToken).finishMemberExpression('.', expr, property);
            } else if (match('(')) {
                isBindingElement = false;
                isAssignmentTarget = false;
                args = parseArguments();
                expr = new WrappingNode(startToken).finishCallExpression(expr, args);
            } else if (match('[')) {
                isBindingElement = false;
                isAssignmentTarget = true;
                property = parseComputedMember();
                expr = new WrappingNode(startToken).finishMemberExpression('[', expr, property);
            } else if (lookahead.type === Token.Template && lookahead.head) {
                quasi = parseTemplateLiteral();
                expr = new WrappingNode(startToken).finishTaggedTemplateExpression(expr, quasi);
            } else {
                break;
            }
        }
        state.allowIn = previousAllowIn;

        return expr;
    }

    // ECMA-262 12.3 Left-Hand-Side Expressions

    function parseLeftHandSideExpression() {
        var quasi, expr, property, startToken;
        assert(state.allowIn, 'callee of new expression always allow in keyword.');

        startToken = lookahead;

        if (matchKeyword('super') && state.inFunctionBody) {
            expr = new Node();
            lex();
            expr = expr.finishSuper();
            if (!match('[') && !match('.')) {
                throwUnexpectedToken(lookahead);
            }
        } else {
            expr = inheritCoverGrammar(matchKeyword('new') ? parseNewExpression : parsePrimaryExpression);
        }

        for (;;) {
            if (match('[')) {
                isBindingElement = false;
                isAssignmentTarget = true;
                property = parseComputedMember();
                expr = new WrappingNode(startToken).finishMemberExpression('[', expr, property);
            } else if (match('.')) {
                isBindingElement = false;
                isAssignmentTarget = true;
                property = parseNonComputedMember();
                expr = new WrappingNode(startToken).finishMemberExpression('.', expr, property);
            } else if (lookahead.type === Token.Template && lookahead.head) {
                quasi = parseTemplateLiteral();
                expr = new WrappingNode(startToken).finishTaggedTemplateExpression(expr, quasi);
            } else {
                break;
            }
        }
        return expr;
    }

    // ECMA-262 12.4 Postfix Expressions

    function parsePostfixExpression() {
        var expr, token, startToken = lookahead;

        expr = inheritCoverGrammar(parseLeftHandSideExpressionAllowCall);

        if (!hasLineTerminator && lookahead.type === Token.Punctuator) {
            if (match('++') || match('--')) {
                // ECMA-262 11.3.1, 11.3.2
                if (strict && expr.type === Syntax.Identifier && isRestrictedWord(expr.name)) {
                    tolerateError(Messages.StrictLHSPostfix);
                }

                if (!isAssignmentTarget) {
                    tolerateError(Messages.InvalidLHSInAssignment);
                }

                isAssignmentTarget = isBindingElement = false;

                token = lex();
                expr = new WrappingNode(startToken).finishPostfixExpression(token.value, expr);
            }
        }

        return expr;
    }

    // ECMA-262 12.5 Unary Operators

    function parseUnaryExpression() {
        var token, expr, startToken;

        if (lookahead.type !== Token.Punctuator && lookahead.type !== Token.Keyword) {
            expr = parsePostfixExpression();
        } else if (match('++') || match('--')) {
            startToken = lookahead;
            token = lex();
            expr = inheritCoverGrammar(parseUnaryExpression);
            // ECMA-262 11.4.4, 11.4.5
            if (strict && expr.type === Syntax.Identifier && isRestrictedWord(expr.name)) {
                tolerateError(Messages.StrictLHSPrefix);
            }

            if (!isAssignmentTarget) {
                tolerateError(Messages.InvalidLHSInAssignment);
            }
            expr = new WrappingNode(startToken).finishUnaryExpression(token.value, expr);
            isAssignmentTarget = isBindingElement = false;
        } else if (match('+') || match('-') || match('~') || match('!')) {
            startToken = lookahead;
            token = lex();
            expr = inheritCoverGrammar(parseUnaryExpression);
            expr = new WrappingNode(startToken).finishUnaryExpression(token.value, expr);
            isAssignmentTarget = isBindingElement = false;
        } else if (matchKeyword('delete') || matchKeyword('void') || matchKeyword('typeof')) {
            startToken = lookahead;
            token = lex();
            expr = inheritCoverGrammar(parseUnaryExpression);
            expr = new WrappingNode(startToken).finishUnaryExpression(token.value, expr);
            if (strict && expr.operator === 'delete' && expr.argument.type === Syntax.Identifier) {
                tolerateError(Messages.StrictDelete);
            }
            isAssignmentTarget = isBindingElement = false;
        } else {
            expr = parsePostfixExpression();
        }

        return expr;
    }

    function binaryPrecedence(token, allowIn) {
        var prec = 0;

        if (token.type !== Token.Punctuator && token.type !== Token.Keyword) {
            return 0;
        }

        switch (token.value) {
        case '||':
            prec = 1;
            break;

        case '&&':
            prec = 2;
            break;

        case '|':
            prec = 3;
            break;

        case '^':
            prec = 4;
            break;

        case '&':
            prec = 5;
            break;

        case '==':
        case '!=':
        case '===':
        case '!==':
            prec = 6;
            break;

        case '<':
        case '>':
        case '<=':
        case '>=':
        case 'instanceof':
            prec = 7;
            break;

        case 'in':
            prec = allowIn ? 7 : 0;
            break;

        case '<<':
        case '>>':
        case '>>>':
            prec = 8;
            break;

        case '+':
        case '-':
            prec = 9;
            break;

        case '*':
        case '/':
        case '%':
            prec = 11;
            break;

        default:
            break;
        }

        return prec;
    }

    // ECMA-262 12.6 Multiplicative Operators
    // ECMA-262 12.7 Additive Operators
    // ECMA-262 12.8 Bitwise Shift Operators
    // ECMA-262 12.9 Relational Operators
    // ECMA-262 12.10 Equality Operators
    // ECMA-262 12.11 Binary Bitwise Operators
    // ECMA-262 12.12 Binary Logical Operators

    function parseBinaryExpression() {
        var marker, markers, expr, token, prec, stack, right, operator, left, i;

        marker = lookahead;
        left = inheritCoverGrammar(parseUnaryExpression);

        token = lookahead;
        prec = binaryPrecedence(token, state.allowIn);
        if (prec === 0) {
            return left;
        }
        isAssignmentTarget = isBindingElement = false;
        token.prec = prec;
        lex();

        markers = [marker, lookahead];
        right = isolateCoverGrammar(parseUnaryExpression);

        stack = [left, token, right];

        while ((prec = binaryPrecedence(lookahead, state.allowIn)) > 0) {

            // Reduce: make a binary expression from the three topmost entries.
            while ((stack.length > 2) && (prec <= stack[stack.length - 2].prec)) {
                right = stack.pop();
                operator = stack.pop().value;
                left = stack.pop();
                markers.pop();
                expr = new WrappingNode(markers[markers.length - 1]).finishBinaryExpression(operator, left, right);
                stack.push(expr);
            }

            // Shift.
            token = lex();
            token.prec = prec;
            stack.push(token);
            markers.push(lookahead);
            expr = isolateCoverGrammar(parseUnaryExpression);
            stack.push(expr);
        }

        // Final reduce to clean-up the stack.
        i = stack.length - 1;
        expr = stack[i];
        markers.pop();
        while (i > 1) {
            expr = new WrappingNode(markers.pop()).finishBinaryExpression(stack[i - 1].value, stack[i - 2], expr);
            i -= 2;
        }

        return expr;
    }


    // ECMA-262 12.13 Conditional Operator

    function parseConditionalExpression() {
        var expr, previousAllowIn, consequent, alternate, startToken;

        startToken = lookahead;

        expr = inheritCoverGrammar(parseBinaryExpression);
        if (match('?')) {
            lex();
            previousAllowIn = state.allowIn;
            state.allowIn = true;
            consequent = isolateCoverGrammar(parseAssignmentExpression);
            state.allowIn = previousAllowIn;
            expect(':');
            alternate = isolateCoverGrammar(parseAssignmentExpression);

            expr = new WrappingNode(startToken).finishConditionalExpression(expr, consequent, alternate);
            isAssignmentTarget = isBindingElement = false;
        }

        return expr;
    }

    // ECMA-262 14.2 Arrow Function Definitions

    function parseConciseBody() {
        if (match('{')) {
            return parseFunctionSourceElements();
        }
        return isolateCoverGrammar(parseAssignmentExpression);
    }

    function checkPatternParam(options, param) {
        var i;
        switch (param.type) {
        case Syntax.Identifier:
            validateParam(options, param, param.name);
            break;
        case Syntax.RestElement:
            checkPatternParam(options, param.argument);
            break;
        case Syntax.AssignmentPattern:
            checkPatternParam(options, param.left);
            break;
        case Syntax.ArrayPattern:
            for (i = 0; i < param.elements.length; i++) {
                if (param.elements[i] !== null) {
                    checkPatternParam(options, param.elements[i]);
                }
            }
            break;
        case Syntax.YieldExpression:
            break;
        default:
            assert(param.type === Syntax.ObjectPattern, 'Invalid type');
            for (i = 0; i < param.properties.length; i++) {
                checkPatternParam(options, param.properties[i].value);
            }
            break;
        }
    }
    function reinterpretAsCoverFormalsList(expr) {
        var i, len, param, params, defaults, defaultCount, options, token;

        defaults = [];
        defaultCount = 0;
        params = [expr];

        switch (expr.type) {
        case Syntax.Identifier:
            break;
        case PlaceHolders.ArrowParameterPlaceHolder:
            params = expr.params;
            break;
        default:
            return null;
        }

        options = {
            paramSet: {}
        };

        for (i = 0, len = params.length; i < len; i += 1) {
            param = params[i];
            switch (param.type) {
            case Syntax.AssignmentPattern:
                params[i] = param.left;
                if (param.right.type === Syntax.YieldExpression) {
                    if (param.right.argument) {
                        throwUnexpectedToken(lookahead);
                    }
                    param.right.type = Syntax.Identifier;
                    param.right.name = 'yield';
                    delete param.right.argument;
                    delete param.right.delegate;
                }
                defaults.push(param.right);
                ++defaultCount;
                checkPatternParam(options, param.left);
                break;
            default:
                checkPatternParam(options, param);
                params[i] = param;
                defaults.push(null);
                break;
            }
        }

        if (strict || !state.allowYield) {
            for (i = 0, len = params.length; i < len; i += 1) {
                param = params[i];
                if (param.type === Syntax.YieldExpression) {
                    throwUnexpectedToken(lookahead);
                }
            }
        }

        if (options.message === Messages.StrictParamDupe) {
            token = strict ? options.stricted : options.firstRestricted;
            throwUnexpectedToken(token, options.message);
        }

        if (defaultCount === 0) {
            defaults = [];
        }

        return {
            params: params,
            defaults: defaults,
            stricted: options.stricted,
            firstRestricted: options.firstRestricted,
            message: options.message
        };
    }

    function parseArrowFunctionExpression(options, node) {
        var previousStrict, previousAllowYield, body;

        if (hasLineTerminator) {
            tolerateUnexpectedToken(lookahead);
        }
        expect('=>');

        previousStrict = strict;
        previousAllowYield = state.allowYield;
        state.allowYield = true;

        body = parseConciseBody();

        if (strict && options.firstRestricted) {
            throwUnexpectedToken(options.firstRestricted, options.message);
        }
        if (strict && options.stricted) {
            tolerateUnexpectedToken(options.stricted, options.message);
        }

        strict = previousStrict;
        state.allowYield = previousAllowYield;

        return node.finishArrowFunctionExpression(options.params, options.defaults, body, body.type !== Syntax.BlockStatement);
    }

    // ECMA-262 14.4 Yield expression

    function parseYieldExpression() {
        var argument, expr, delegate, previousAllowYield;

        argument = null;
        expr = new Node();
        delegate = false;

        expectKeyword('yield');

        if (!hasLineTerminator) {
            previousAllowYield = state.allowYield;
            state.allowYield = false;
            delegate = match('*');
            if (delegate) {
                lex();
                argument = parseAssignmentExpression();
            } else {
                if (!match(';') && !match('}') && !match(')') && lookahead.type !== Token.EOF) {
                    argument = parseAssignmentExpression();
                }
            }
            state.allowYield = previousAllowYield;
        }

        return expr.finishYieldExpression(argument, delegate);
    }

    // ECMA-262 12.14 Assignment Operators

    function parseAssignmentExpression() {
        var token, expr, right, list, startToken;

        startToken = lookahead;
        token = lookahead;

        if (!state.allowYield && matchKeyword('yield')) {
            return parseYieldExpression();
        }

        expr = parseConditionalExpression();

        if (expr.type === PlaceHolders.ArrowParameterPlaceHolder || match('=>')) {
            isAssignmentTarget = isBindingElement = false;
            list = reinterpretAsCoverFormalsList(expr);

            if (list) {
                firstCoverInitializedNameError = null;
                return parseArrowFunctionExpression(list, new WrappingNode(startToken));
            }

            return expr;
        }

        if (matchAssign()) {
            if (!isAssignmentTarget) {
                tolerateError(Messages.InvalidLHSInAssignment);
            }

            // ECMA-262 12.1.1
            if (strict && expr.type === Syntax.Identifier) {
                if (isRestrictedWord(expr.name)) {
                    tolerateUnexpectedToken(token, Messages.StrictLHSAssignment);
                }
                if (isStrictModeReservedWord(expr.name)) {
                    tolerateUnexpectedToken(token, Messages.StrictReservedWord);
                }
            }

            if (!match('=')) {
                isAssignmentTarget = isBindingElement = false;
            } else {
                reinterpretExpressionAsPattern(expr);
            }

            token = lex();
            right = isolateCoverGrammar(parseAssignmentExpression);
            expr = new WrappingNode(startToken).finishAssignmentExpression(token.value, expr, right);
            firstCoverInitializedNameError = null;
        }

        return expr;
    }

    // ECMA-262 12.15 Comma Operator

    function parseExpression() {
        var expr, startToken = lookahead, expressions;

        expr = isolateCoverGrammar(parseAssignmentExpression);

        if (match(',')) {
            expressions = [expr];

            while (startIndex < length) {
                if (!match(',')) {
                    break;
                }
                lex();
                expressions.push(isolateCoverGrammar(parseAssignmentExpression));
            }

            expr = new WrappingNode(startToken).finishSequenceExpression(expressions);
        }

        return expr;
    }

    // ECMA-262 13.2 Block

    function parseStatementListItem() {
        if (lookahead.type === Token.Keyword) {
            switch (lookahead.value) {
            case 'export':
                if (state.sourceType !== 'module') {
                    tolerateUnexpectedToken(lookahead, Messages.IllegalExportDeclaration);
                }
                return parseExportDeclaration();
            case 'import':
                if (state.sourceType !== 'module') {
                    tolerateUnexpectedToken(lookahead, Messages.IllegalImportDeclaration);
                }
                return parseImportDeclaration();
            case 'const':
                return parseLexicalDeclaration({inFor: false});
            case 'function':
                return parseFunctionDeclaration(new Node());
            case 'class':
                return parseClassDeclaration();
            }
        }

        if (matchKeyword('let') && isLexicalDeclaration()) {
            return parseLexicalDeclaration({inFor: false});
        }

        return parseStatement();
    }

    function parseStatementList() {
        var list = [];
        while (startIndex < length) {
            if (match('}')) {
                break;
            }
            list.push(parseStatementListItem());
        }

        return list;
    }

    function parseBlock() {
        var block, node = new Node();

        expect('{');

        block = parseStatementList();

        expect('}');

        return node.finishBlockStatement(block);
    }

    // ECMA-262 13.3.2 Variable Statement

    function parseVariableIdentifier(kind) {
        var token, node = new Node();

        token = lex();

        if (token.type === Token.Keyword && token.value === 'yield') {
            if (strict) {
                tolerateUnexpectedToken(token, Messages.StrictReservedWord);
            } if (!state.allowYield) {
                throwUnexpectedToken(token);
            }
        } else if (token.type !== Token.Identifier) {
            if (strict && token.type === Token.Keyword && isStrictModeReservedWord(token.value)) {
                tolerateUnexpectedToken(token, Messages.StrictReservedWord);
            } else {
                if (strict || token.value !== 'let' || kind !== 'var') {
                    throwUnexpectedToken(token);
                }
            }
        } else if (state.sourceType === 'module' && token.type === Token.Identifier && token.value === 'await') {
            tolerateUnexpectedToken(token);
        }

        return node.finishIdentifier(token.value);
    }

    function parseVariableDeclaration(options) {
        var init = null, id, node = new Node(), params = [];

        id = parsePattern(params, 'var');

        // ECMA-262 12.2.1
        if (strict && isRestrictedWord(id.name)) {
            tolerateError(Messages.StrictVarName);
        }

        if (match('=')) {
            lex();
            init = isolateCoverGrammar(parseAssignmentExpression);
        } else if (id.type !== Syntax.Identifier && !options.inFor) {
            expect('=');
        }

        return node.finishVariableDeclarator(id, init);
    }

    function parseVariableDeclarationList(options) {
        var opt, list;

        opt = { inFor: options.inFor };
        list = [parseVariableDeclaration(opt)];

        while (match(',')) {
            lex();
            list.push(parseVariableDeclaration(opt));
        }

        return list;
    }

    function parseVariableStatement(node) {
        var declarations;

        expectKeyword('var');

        declarations = parseVariableDeclarationList({ inFor: false });

        consumeSemicolon();

        return node.finishVariableDeclaration(declarations);
    }

    // ECMA-262 13.3.1 Let and Const Declarations

    function parseLexicalBinding(kind, options) {
        var init = null, id, node = new Node(), params = [];

        id = parsePattern(params, kind);

        // ECMA-262 12.2.1
        if (strict && id.type === Syntax.Identifier && isRestrictedWord(id.name)) {
            tolerateError(Messages.StrictVarName);
        }

        if (kind === 'const') {
            if (!matchKeyword('in') && !matchContextualKeyword('of')) {
                expect('=');
                init = isolateCoverGrammar(parseAssignmentExpression);
            }
        } else if ((!options.inFor && id.type !== Syntax.Identifier) || match('=')) {
            expect('=');
            init = isolateCoverGrammar(parseAssignmentExpression);
        }

        return node.finishVariableDeclarator(id, init);
    }

    function parseBindingList(kind, options) {
        var list = [parseLexicalBinding(kind, options)];

        while (match(',')) {
            lex();
            list.push(parseLexicalBinding(kind, options));
        }

        return list;
    }


    function tokenizerState() {
        return {
            index: index,
            lineNumber: lineNumber,
            lineStart: lineStart,
            hasLineTerminator: hasLineTerminator,
            lastIndex: lastIndex,
            lastLineNumber: lastLineNumber,
            lastLineStart: lastLineStart,
            startIndex: startIndex,
            startLineNumber: startLineNumber,
            startLineStart: startLineStart,
            lookahead: lookahead,
            tokenCount: extra.tokens ? extra.tokens.length : 0
        };
    }

    function resetTokenizerState(ts) {
        index = ts.index;
        lineNumber = ts.lineNumber;
        lineStart = ts.lineStart;
        hasLineTerminator = ts.hasLineTerminator;
        lastIndex = ts.lastIndex;
        lastLineNumber = ts.lastLineNumber;
        lastLineStart = ts.lastLineStart;
        startIndex = ts.startIndex;
        startLineNumber = ts.startLineNumber;
        startLineStart = ts.startLineStart;
        lookahead = ts.lookahead;
        if (extra.tokens) {
            extra.tokens.splice(ts.tokenCount, extra.tokens.length);
        }
    }

    function isLexicalDeclaration() {
        var lexical, ts;

        ts = tokenizerState();

        lex();
        lexical = (lookahead.type === Token.Identifier) || match('[') || match('{') ||
            matchKeyword('let') || matchKeyword('yield');

        resetTokenizerState(ts);

        return lexical;
    }

    function parseLexicalDeclaration(options) {
        var kind, declarations, node = new Node();

        kind = lex().value;
        assert(kind === 'let' || kind === 'const', 'Lexical declaration must be either let or const');

        declarations = parseBindingList(kind, options);

        consumeSemicolon();

        return node.finishLexicalDeclaration(declarations, kind);
    }

    function parseRestElement(params) {
        var param, node = new Node();

        lex();

        if (match('{')) {
            throwError(Messages.ObjectPatternAsRestParameter);
        }

        params.push(lookahead);

        param = parseVariableIdentifier();

        if (match('=')) {
            throwError(Messages.DefaultRestParameter);
        }

        if (!match(')')) {
            throwError(Messages.ParameterAfterRestParameter);
        }

        return node.finishRestElement(param);
    }

    // ECMA-262 13.4 Empty Statement

    function parseEmptyStatement(node) {
        expect(';');
        return node.finishEmptyStatement();
    }

    // ECMA-262 12.4 Expression Statement

    function parseExpressionStatement(node) {
        var expr = parseExpression();
        consumeSemicolon();
        return node.finishExpressionStatement(expr);
    }

    // ECMA-262 13.6 If statement

    function parseIfStatement(node) {
        var test, consequent, alternate;

        expectKeyword('if');

        expect('(');

        test = parseExpression();

        expect(')');

        consequent = parseStatement();

        if (matchKeyword('else')) {
            lex();
            alternate = parseStatement();
        } else {
            alternate = null;
        }

        return node.finishIfStatement(test, consequent, alternate);
    }

    // ECMA-262 13.7 Iteration Statements

    function parseDoWhileStatement(node) {
        var body, test, oldInIteration;

        expectKeyword('do');

        oldInIteration = state.inIteration;
        state.inIteration = true;

        body = parseStatement();

        state.inIteration = oldInIteration;

        expectKeyword('while');

        expect('(');

        test = parseExpression();

        expect(')');

        if (match(';')) {
            lex();
        }

        return node.finishDoWhileStatement(body, test);
    }

    function parseWhileStatement(node) {
        var test, body, oldInIteration;

        expectKeyword('while');

        expect('(');

        test = parseExpression();

        expect(')');

        oldInIteration = state.inIteration;
        state.inIteration = true;

        body = parseStatement();

        state.inIteration = oldInIteration;

        return node.finishWhileStatement(test, body);
    }

    function parseForStatement(node) {
        var init, forIn, initSeq, initStartToken, test, update, left, right, kind, declarations,
            body, oldInIteration, previousAllowIn = state.allowIn;

        init = test = update = null;
        forIn = true;

        expectKeyword('for');

        expect('(');

        if (match(';')) {
            lex();
        } else {
            if (matchKeyword('var')) {
                init = new Node();
                lex();

                state.allowIn = false;
                declarations = parseVariableDeclarationList({ inFor: true });
                state.allowIn = previousAllowIn;

                if (declarations.length === 1 && matchKeyword('in')) {
                    init = init.finishVariableDeclaration(declarations);
                    lex();
                    left = init;
                    right = parseExpression();
                    init = null;
                } else if (declarations.length === 1 && declarations[0].init === null && matchContextualKeyword('of')) {
                    init = init.finishVariableDeclaration(declarations);
                    lex();
                    left = init;
                    right = parseAssignmentExpression();
                    init = null;
                    forIn = false;
                } else {
                    init = init.finishVariableDeclaration(declarations);
                    expect(';');
                }
            } else if (matchKeyword('const') || matchKeyword('let')) {
                init = new Node();
                kind = lex().value;

                if (!strict && lookahead.value === 'in') {
                    init = init.finishIdentifier(kind);
                    lex();
                    left = init;
                    right = parseExpression();
                    init = null;
                } else {
                    state.allowIn = false;
                    declarations = parseBindingList(kind, {inFor: true});
                    state.allowIn = previousAllowIn;

                    if (declarations.length === 1 && declarations[0].init === null && matchKeyword('in')) {
                        init = init.finishLexicalDeclaration(declarations, kind);
                        lex();
                        left = init;
                        right = parseExpression();
                        init = null;
                    } else if (declarations.length === 1 && declarations[0].init === null && matchContextualKeyword('of')) {
                        init = init.finishLexicalDeclaration(declarations, kind);
                        lex();
                        left = init;
                        right = parseAssignmentExpression();
                        init = null;
                        forIn = false;
                    } else {
                        consumeSemicolon();
                        init = init.finishLexicalDeclaration(declarations, kind);
                    }
                }
            } else {
                initStartToken = lookahead;
                state.allowIn = false;
                init = inheritCoverGrammar(parseAssignmentExpression);
                state.allowIn = previousAllowIn;

                if (matchKeyword('in')) {
                    if (!isAssignmentTarget) {
                        tolerateError(Messages.InvalidLHSInForIn);
                    }

                    lex();
                    reinterpretExpressionAsPattern(init);
                    left = init;
                    right = parseExpression();
                    init = null;
                } else if (matchContextualKeyword('of')) {
                    if (!isAssignmentTarget) {
                        tolerateError(Messages.InvalidLHSInForLoop);
                    }

                    lex();
                    reinterpretExpressionAsPattern(init);
                    left = init;
                    right = parseAssignmentExpression();
                    init = null;
                    forIn = false;
                } else {
                    if (match(',')) {
                        initSeq = [init];
                        while (match(',')) {
                            lex();
                            initSeq.push(isolateCoverGrammar(parseAssignmentExpression));
                        }
                        init = new WrappingNode(initStartToken).finishSequenceExpression(initSeq);
                    }
                    expect(';');
                }
            }
        }

        if (typeof left === 'undefined') {

            if (!match(';')) {
                test = parseExpression();
            }
            expect(';');

            if (!match(')')) {
                update = parseExpression();
            }
        }

        expect(')');

        oldInIteration = state.inIteration;
        state.inIteration = true;

        body = isolateCoverGrammar(parseStatement);

        state.inIteration = oldInIteration;

        return (typeof left === 'undefined') ?
                node.finishForStatement(init, test, update, body) :
                forIn ? node.finishForInStatement(left, right, body) :
                    node.finishForOfStatement(left, right, body);
    }

    // ECMA-262 13.8 The continue statement

    function parseContinueStatement(node) {
        var label = null, key;

        expectKeyword('continue');

        // Optimize the most common form: 'continue;'.
        if (source.charCodeAt(startIndex) === 0x3B) {
            lex();

            if (!state.inIteration) {
                throwError(Messages.IllegalContinue);
            }

            return node.finishContinueStatement(null);
        }

        if (hasLineTerminator) {
            if (!state.inIteration) {
                throwError(Messages.IllegalContinue);
            }

            return node.finishContinueStatement(null);
        }

        if (lookahead.type === Token.Identifier) {
            label = parseVariableIdentifier();

            key = '$' + label.name;
            if (!Object.prototype.hasOwnProperty.call(state.labelSet, key)) {
                throwError(Messages.UnknownLabel, label.name);
            }
        }

        consumeSemicolon();

        if (label === null && !state.inIteration) {
            throwError(Messages.IllegalContinue);
        }

        return node.finishContinueStatement(label);
    }

    // ECMA-262 13.9 The break statement

    function parseBreakStatement(node) {
        var label = null, key;

        expectKeyword('break');

        // Catch the very common case first: immediately a semicolon (U+003B).
        if (source.charCodeAt(lastIndex) === 0x3B) {
            lex();

            if (!(state.inIteration || state.inSwitch)) {
                throwError(Messages.IllegalBreak);
            }

            return node.finishBreakStatement(null);
        }

        if (hasLineTerminator) {
            if (!(state.inIteration || state.inSwitch)) {
                throwError(Messages.IllegalBreak);
            }
        } else if (lookahead.type === Token.Identifier) {
            label = parseVariableIdentifier();

            key = '$' + label.name;
            if (!Object.prototype.hasOwnProperty.call(state.labelSet, key)) {
                throwError(Messages.UnknownLabel, label.name);
            }
        }

        consumeSemicolon();

        if (label === null && !(state.inIteration || state.inSwitch)) {
            throwError(Messages.IllegalBreak);
        }

        return node.finishBreakStatement(label);
    }

    // ECMA-262 13.10 The return statement

    function parseReturnStatement(node) {
        var argument = null;

        expectKeyword('return');

        if (!state.inFunctionBody) {
            tolerateError(Messages.IllegalReturn);
        }

        // 'return' followed by a space and an identifier is very common.
        if (source.charCodeAt(lastIndex) === 0x20) {
            if (isIdentifierStart(source.charCodeAt(lastIndex + 1))) {
                argument = parseExpression();
                consumeSemicolon();
                return node.finishReturnStatement(argument);
            }
        }

        if (hasLineTerminator) {
            // HACK
            return node.finishReturnStatement(null);
        }

        if (!match(';')) {
            if (!match('}') && lookahead.type !== Token.EOF) {
                argument = parseExpression();
            }
        }

        consumeSemicolon();

        return node.finishReturnStatement(argument);
    }

    // ECMA-262 13.11 The with statement

    function parseWithStatement(node) {
        var object, body;

        if (strict) {
            tolerateError(Messages.StrictModeWith);
        }

        expectKeyword('with');

        expect('(');

        object = parseExpression();

        expect(')');

        body = parseStatement();

        return node.finishWithStatement(object, body);
    }

    // ECMA-262 13.12 The switch statement

    function parseSwitchCase() {
        var test, consequent = [], statement, node = new Node();

        if (matchKeyword('default')) {
            lex();
            test = null;
        } else {
            expectKeyword('case');
            test = parseExpression();
        }
        expect(':');

        while (startIndex < length) {
            if (match('}') || matchKeyword('default') || matchKeyword('case')) {
                break;
            }
            statement = parseStatementListItem();
            consequent.push(statement);
        }

        return node.finishSwitchCase(test, consequent);
    }

    function parseSwitchStatement(node) {
        var discriminant, cases, clause, oldInSwitch, defaultFound;

        expectKeyword('switch');

        expect('(');

        discriminant = parseExpression();

        expect(')');

        expect('{');

        cases = [];

        if (match('}')) {
            lex();
            return node.finishSwitchStatement(discriminant, cases);
        }

        oldInSwitch = state.inSwitch;
        state.inSwitch = true;
        defaultFound = false;

        while (startIndex < length) {
            if (match('}')) {
                break;
            }
            clause = parseSwitchCase();
            if (clause.test === null) {
                if (defaultFound) {
                    throwError(Messages.MultipleDefaultsInSwitch);
                }
                defaultFound = true;
            }
            cases.push(clause);
        }

        state.inSwitch = oldInSwitch;

        expect('}');

        return node.finishSwitchStatement(discriminant, cases);
    }

    // ECMA-262 13.14 The throw statement

    function parseThrowStatement(node) {
        var argument;

        expectKeyword('throw');

        if (hasLineTerminator) {
            throwError(Messages.NewlineAfterThrow);
        }

        argument = parseExpression();

        consumeSemicolon();

        return node.finishThrowStatement(argument);
    }

    // ECMA-262 13.15 The try statement

    function parseCatchClause() {
        var param, params = [], paramMap = {}, key, i, body, node = new Node();

        expectKeyword('catch');

        expect('(');
        if (match(')')) {
            throwUnexpectedToken(lookahead);
        }

        param = parsePattern(params);
        for (i = 0; i < params.length; i++) {
            key = '$' + params[i].value;
            if (Object.prototype.hasOwnProperty.call(paramMap, key)) {
                tolerateError(Messages.DuplicateBinding, params[i].value);
            }
            paramMap[key] = true;
        }

        // ECMA-262 12.14.1
        if (strict && isRestrictedWord(param.name)) {
            tolerateError(Messages.StrictCatchVariable);
        }

        expect(')');
        body = parseBlock();
        return node.finishCatchClause(param, body);
    }

    function parseTryStatement(node) {
        var block, handler = null, finalizer = null;

        expectKeyword('try');

        block = parseBlock();

        if (matchKeyword('catch')) {
            handler = parseCatchClause();
        }

        if (matchKeyword('finally')) {
            lex();
            finalizer = parseBlock();
        }

        if (!handler && !finalizer) {
            throwError(Messages.NoCatchOrFinally);
        }

        return node.finishTryStatement(block, handler, finalizer);
    }

    // ECMA-262 13.16 The debugger statement

    function parseDebuggerStatement(node) {
        expectKeyword('debugger');

        consumeSemicolon();

        return node.finishDebuggerStatement();
    }

    // 13 Statements

    function parseStatement() {
        var type = lookahead.type,
            expr,
            labeledBody,
            key,
            node;

        if (type === Token.EOF) {
            throwUnexpectedToken(lookahead);
        }

        if (type === Token.Punctuator && lookahead.value === '{') {
            return parseBlock();
        }
        isAssignmentTarget = isBindingElement = true;
        node = new Node();

        if (type === Token.Punctuator) {
            switch (lookahead.value) {
            case ';':
                return parseEmptyStatement(node);
            case '(':
                return parseExpressionStatement(node);
            default:
                break;
            }
        } else if (type === Token.Keyword) {
            switch (lookahead.value) {
            case 'break':
                return parseBreakStatement(node);
            case 'continue':
                return parseContinueStatement(node);
            case 'debugger':
                return parseDebuggerStatement(node);
            case 'do':
                return parseDoWhileStatement(node);
            case 'for':
                return parseForStatement(node);
            case 'function':
                return parseFunctionDeclaration(node);
            case 'if':
                return parseIfStatement(node);
            case 'return':
                return parseReturnStatement(node);
            case 'switch':
                return parseSwitchStatement(node);
            case 'throw':
                return parseThrowStatement(node);
            case 'try':
                return parseTryStatement(node);
            case 'var':
                return parseVariableStatement(node);
            case 'while':
                return parseWhileStatement(node);
            case 'with':
                return parseWithStatement(node);
            default:
                break;
            }
        }

        expr = parseExpression();

        // ECMA-262 12.12 Labelled Statements
        if ((expr.type === Syntax.Identifier) && match(':')) {
            lex();

            key = '$' + expr.name;
            if (Object.prototype.hasOwnProperty.call(state.labelSet, key)) {
                throwError(Messages.Redeclaration, 'Label', expr.name);
            }

            state.labelSet[key] = true;
            labeledBody = parseStatement();
            delete state.labelSet[key];
            return node.finishLabeledStatement(expr, labeledBody);
        }

        consumeSemicolon();

        return node.finishExpressionStatement(expr);
    }

    // ECMA-262 14.1 Function Definition

    function parseFunctionSourceElements() {
        var statement, body = [], token, directive, firstRestricted,
            oldLabelSet, oldInIteration, oldInSwitch, oldInFunctionBody,
            node = new Node();

        expect('{');

        while (startIndex < length) {
            if (lookahead.type !== Token.StringLiteral) {
                break;
            }
            token = lookahead;

            statement = parseStatementListItem();
            body.push(statement);
            if (statement.expression.type !== Syntax.Literal) {
                // this is not directive
                break;
            }
            directive = source.slice(token.start + 1, token.end - 1);
            if (directive === 'use strict') {
                strict = true;
                if (firstRestricted) {
                    tolerateUnexpectedToken(firstRestricted, Messages.StrictOctalLiteral);
                }
            } else {
                if (!firstRestricted && token.octal) {
                    firstRestricted = token;
                }
            }
        }

        oldLabelSet = state.labelSet;
        oldInIteration = state.inIteration;
        oldInSwitch = state.inSwitch;
        oldInFunctionBody = state.inFunctionBody;

        state.labelSet = {};
        state.inIteration = false;
        state.inSwitch = false;
        state.inFunctionBody = true;

        while (startIndex < length) {
            if (match('}')) {
                break;
            }
            body.push(parseStatementListItem());
        }

        expect('}');

        state.labelSet = oldLabelSet;
        state.inIteration = oldInIteration;
        state.inSwitch = oldInSwitch;
        state.inFunctionBody = oldInFunctionBody;

        return node.finishBlockStatement(body);
    }

    function validateParam(options, param, name) {
        var key = '$' + name;
        if (strict) {
            if (isRestrictedWord(name)) {
                options.stricted = param;
                options.message = Messages.StrictParamName;
            }
            if (Object.prototype.hasOwnProperty.call(options.paramSet, key)) {
                options.stricted = param;
                options.message = Messages.StrictParamDupe;
            }
        } else if (!options.firstRestricted) {
            if (isRestrictedWord(name)) {
                options.firstRestricted = param;
                options.message = Messages.StrictParamName;
            } else if (isStrictModeReservedWord(name)) {
                options.firstRestricted = param;
                options.message = Messages.StrictReservedWord;
            } else if (Object.prototype.hasOwnProperty.call(options.paramSet, key)) {
                options.stricted = param;
                options.message = Messages.StrictParamDupe;
            }
        }
        options.paramSet[key] = true;
    }

    function parseParam(options) {
        var token, param, params = [], i, def;

        token = lookahead;
        if (token.value === '...') {
            param = parseRestElement(params);
            validateParam(options, param.argument, param.argument.name);
            options.params.push(param);
            options.defaults.push(null);
            return false;
        }

        param = parsePatternWithDefault(params);
        for (i = 0; i < params.length; i++) {
            validateParam(options, params[i], params[i].value);
        }

        if (param.type === Syntax.AssignmentPattern) {
            def = param.right;
            param = param.left;
            ++options.defaultCount;
        }

        options.params.push(param);
        options.defaults.push(def);

        return !match(')');
    }

    function parseParams(firstRestricted) {
        var options;

        options = {
            params: [],
            defaultCount: 0,
            defaults: [],
            firstRestricted: firstRestricted
        };

        expect('(');

        if (!match(')')) {
            options.paramSet = {};
            while (startIndex < length) {
                if (!parseParam(options)) {
                    break;
                }
                expect(',');
            }
        }

        expect(')');

        if (options.defaultCount === 0) {
            options.defaults = [];
        }

        return {
            params: options.params,
            defaults: options.defaults,
            stricted: options.stricted,
            firstRestricted: options.firstRestricted,
            message: options.message
        };
    }

    function parseFunctionDeclaration(node, identifierIsOptional) {
        var id = null, params = [], defaults = [], body, token, stricted, tmp, firstRestricted, message, previousStrict,
            isGenerator, previousAllowYield;

        previousAllowYield = state.allowYield;

        expectKeyword('function');

        isGenerator = match('*');
        if (isGenerator) {
            lex();
        }

        if (!identifierIsOptional || !match('(')) {
            token = lookahead;
            id = parseVariableIdentifier();
            if (strict) {
                if (isRestrictedWord(token.value)) {
                    tolerateUnexpectedToken(token, Messages.StrictFunctionName);
                }
            } else {
                if (isRestrictedWord(token.value)) {
                    firstRestricted = token;
                    message = Messages.StrictFunctionName;
                } else if (isStrictModeReservedWord(token.value)) {
                    firstRestricted = token;
                    message = Messages.StrictReservedWord;
                }
            }
        }

        state.allowYield = !isGenerator;
        tmp = parseParams(firstRestricted);
        params = tmp.params;
        defaults = tmp.defaults;
        stricted = tmp.stricted;
        firstRestricted = tmp.firstRestricted;
        if (tmp.message) {
            message = tmp.message;
        }


        previousStrict = strict;
        body = parseFunctionSourceElements();
        if (strict && firstRestricted) {
            throwUnexpectedToken(firstRestricted, message);
        }
        if (strict && stricted) {
            tolerateUnexpectedToken(stricted, message);
        }

        strict = previousStrict;
        state.allowYield = previousAllowYield;

        return node.finishFunctionDeclaration(id, params, defaults, body, isGenerator);
    }

    function parseFunctionExpression() {
        var token, id = null, stricted, firstRestricted, message, tmp,
            params = [], defaults = [], body, previousStrict, node = new Node(),
            isGenerator, previousAllowYield;

        previousAllowYield = state.allowYield;

        expectKeyword('function');

        isGenerator = match('*');
        if (isGenerator) {
            lex();
        }

        state.allowYield = !isGenerator;
        if (!match('(')) {
            token = lookahead;
            id = (!strict && !isGenerator && matchKeyword('yield')) ? parseNonComputedProperty() : parseVariableIdentifier();
            if (strict) {
                if (isRestrictedWord(token.value)) {
                    tolerateUnexpectedToken(token, Messages.StrictFunctionName);
                }
            } else {
                if (isRestrictedWord(token.value)) {
                    firstRestricted = token;
                    message = Messages.StrictFunctionName;
                } else if (isStrictModeReservedWord(token.value)) {
                    firstRestricted = token;
                    message = Messages.StrictReservedWord;
                }
            }
        }

        tmp = parseParams(firstRestricted);
        params = tmp.params;
        defaults = tmp.defaults;
        stricted = tmp.stricted;
        firstRestricted = tmp.firstRestricted;
        if (tmp.message) {
            message = tmp.message;
        }

        previousStrict = strict;
        body = parseFunctionSourceElements();
        if (strict && firstRestricted) {
            throwUnexpectedToken(firstRestricted, message);
        }
        if (strict && stricted) {
            tolerateUnexpectedToken(stricted, message);
        }
        strict = previousStrict;
        state.allowYield = previousAllowYield;

        return node.finishFunctionExpression(id, params, defaults, body, isGenerator);
    }

    // ECMA-262 14.5 Class Definitions

    function parseClassBody() {
        var classBody, token, isStatic, hasConstructor = false, body, method, computed, key;

        classBody = new Node();

        expect('{');
        body = [];
        while (!match('}')) {
            if (match(';')) {
                lex();
            } else {
                method = new Node();
                token = lookahead;
                isStatic = false;
                computed = match('[');
                if (match('*')) {
                    lex();
                } else {
                    key = parseObjectPropertyKey();
                    if (key.name === 'static' && (lookaheadPropertyName() || match('*'))) {
                        token = lookahead;
                        isStatic = true;
                        computed = match('[');
                        if (match('*')) {
                            lex();
                        } else {
                            key = parseObjectPropertyKey();
                        }
                    }
                }
                method = tryParseMethodDefinition(token, key, computed, method);
                if (method) {
                    method['static'] = isStatic; // jscs:ignore requireDotNotation
                    if (method.kind === 'init') {
                        method.kind = 'method';
                    }
                    if (!isStatic) {
                        if (!method.computed && (method.key.name || method.key.value.toString()) === 'constructor') {
                            if (method.kind !== 'method' || !method.method || method.value.generator) {
                                throwUnexpectedToken(token, Messages.ConstructorSpecialMethod);
                            }
                            if (hasConstructor) {
                                throwUnexpectedToken(token, Messages.DuplicateConstructor);
                            } else {
                                hasConstructor = true;
                            }
                            method.kind = 'constructor';
                        }
                    } else {
                        if (!method.computed && (method.key.name || method.key.value.toString()) === 'prototype') {
                            throwUnexpectedToken(token, Messages.StaticPrototype);
                        }
                    }
                    method.type = Syntax.MethodDefinition;
                    delete method.method;
                    delete method.shorthand;
                    body.push(method);
                } else {
                    throwUnexpectedToken(lookahead);
                }
            }
        }
        lex();
        return classBody.finishClassBody(body);
    }

    function parseClassDeclaration(identifierIsOptional) {
        var id = null, superClass = null, classNode = new Node(), classBody, previousStrict = strict;
        strict = true;

        expectKeyword('class');

        if (!identifierIsOptional || lookahead.type === Token.Identifier) {
            id = parseVariableIdentifier();
        }

        if (matchKeyword('extends')) {
            lex();
            superClass = isolateCoverGrammar(parseLeftHandSideExpressionAllowCall);
        }
        classBody = parseClassBody();
        strict = previousStrict;

        return classNode.finishClassDeclaration(id, superClass, classBody);
    }

    function parseClassExpression() {
        var id = null, superClass = null, classNode = new Node(), classBody, previousStrict = strict;
        strict = true;

        expectKeyword('class');

        if (lookahead.type === Token.Identifier) {
            id = parseVariableIdentifier();
        }

        if (matchKeyword('extends')) {
            lex();
            superClass = isolateCoverGrammar(parseLeftHandSideExpressionAllowCall);
        }
        classBody = parseClassBody();
        strict = previousStrict;

        return classNode.finishClassExpression(id, superClass, classBody);
    }

    // ECMA-262 15.2 Modules

    function parseModuleSpecifier() {
        var node = new Node();

        if (lookahead.type !== Token.StringLiteral) {
            throwError(Messages.InvalidModuleSpecifier);
        }
        return node.finishLiteral(lex());
    }

    // ECMA-262 15.2.3 Exports

    function parseExportSpecifier() {
        var exported, local, node = new Node(), def;
        if (matchKeyword('default')) {
            // export {default} from 'something';
            def = new Node();
            lex();
            local = def.finishIdentifier('default');
        } else {
            local = parseVariableIdentifier();
        }
        if (matchContextualKeyword('as')) {
            lex();
            exported = parseNonComputedProperty();
        }
        return node.finishExportSpecifier(local, exported);
    }

    function parseExportNamedDeclaration(node) {
        var declaration = null,
            isExportFromIdentifier,
            src = null, specifiers = [];

        // non-default export
        if (lookahead.type === Token.Keyword) {
            // covers:
            // export var f = 1;
            switch (lookahead.value) {
                case 'let':
                case 'const':
                    declaration = parseLexicalDeclaration({inFor: false});
                    return node.finishExportNamedDeclaration(declaration, specifiers, null);
                case 'var':
                case 'class':
                case 'function':
                    declaration = parseStatementListItem();
                    return node.finishExportNamedDeclaration(declaration, specifiers, null);
            }
        }

        expect('{');
        while (!match('}')) {
            isExportFromIdentifier = isExportFromIdentifier || matchKeyword('default');
            specifiers.push(parseExportSpecifier());
            if (!match('}')) {
                expect(',');
                if (match('}')) {
                    break;
                }
            }
        }
        expect('}');

        if (matchContextualKeyword('from')) {
            // covering:
            // export {default} from 'foo';
            // export {foo} from 'foo';
            lex();
            src = parseModuleSpecifier();
            consumeSemicolon();
        } else if (isExportFromIdentifier) {
            // covering:
            // export {default}; // missing fromClause
            throwError(lookahead.value ?
                    Messages.UnexpectedToken : Messages.MissingFromClause, lookahead.value);
        } else {
            // cover
            // export {foo};
            consumeSemicolon();
        }
        return node.finishExportNamedDeclaration(declaration, specifiers, src);
    }

    function parseExportDefaultDeclaration(node) {
        var declaration = null,
            expression = null;

        // covers:
        // export default ...
        expectKeyword('default');

        if (matchKeyword('function')) {
            // covers:
            // export default function foo () {}
            // export default function () {}
            declaration = parseFunctionDeclaration(new Node(), true);
            return node.finishExportDefaultDeclaration(declaration);
        }
        if (matchKeyword('class')) {
            declaration = parseClassDeclaration(true);
            return node.finishExportDefaultDeclaration(declaration);
        }

        if (matchContextualKeyword('from')) {
            throwError(Messages.UnexpectedToken, lookahead.value);
        }

        // covers:
        // export default {};
        // export default [];
        // export default (1 + 2);
        if (match('{')) {
            expression = parseObjectInitializer();
        } else if (match('[')) {
            expression = parseArrayInitializer();
        } else {
            expression = parseAssignmentExpression();
        }
        consumeSemicolon();
        return node.finishExportDefaultDeclaration(expression);
    }

    function parseExportAllDeclaration(node) {
        var src;

        // covers:
        // export * from 'foo';
        expect('*');
        if (!matchContextualKeyword('from')) {
            throwError(lookahead.value ?
                    Messages.UnexpectedToken : Messages.MissingFromClause, lookahead.value);
        }
        lex();
        src = parseModuleSpecifier();
        consumeSemicolon();

        return node.finishExportAllDeclaration(src);
    }

    function parseExportDeclaration() {
        var node = new Node();
        if (state.inFunctionBody) {
            throwError(Messages.IllegalExportDeclaration);
        }

        expectKeyword('export');

        if (matchKeyword('default')) {
            return parseExportDefaultDeclaration(node);
        }
        if (match('*')) {
            return parseExportAllDeclaration(node);
        }
        return parseExportNamedDeclaration(node);
    }

    // ECMA-262 15.2.2 Imports

    function parseImportSpecifier() {
        // import {<foo as bar>} ...;
        var local, imported, node = new Node();

        imported = parseNonComputedProperty();
        if (matchContextualKeyword('as')) {
            lex();
            local = parseVariableIdentifier();
        }

        return node.finishImportSpecifier(local, imported);
    }

    function parseNamedImports() {
        var specifiers = [];
        // {foo, bar as bas}
        expect('{');
        while (!match('}')) {
            specifiers.push(parseImportSpecifier());
            if (!match('}')) {
                expect(',');
                if (match('}')) {
                    break;
                }
            }
        }
        expect('}');
        return specifiers;
    }

    function parseImportDefaultSpecifier() {
        // import <foo> ...;
        var local, node = new Node();

        local = parseNonComputedProperty();

        return node.finishImportDefaultSpecifier(local);
    }

    function parseImportNamespaceSpecifier() {
        // import <* as foo> ...;
        var local, node = new Node();

        expect('*');
        if (!matchContextualKeyword('as')) {
            throwError(Messages.NoAsAfterImportNamespace);
        }
        lex();
        local = parseNonComputedProperty();

        return node.finishImportNamespaceSpecifier(local);
    }

    function parseImportDeclaration() {
        var specifiers = [], src, node = new Node();

        if (state.inFunctionBody) {
            throwError(Messages.IllegalImportDeclaration);
        }

        expectKeyword('import');

        if (lookahead.type === Token.StringLiteral) {
            // import 'foo';
            src = parseModuleSpecifier();
        } else {

            if (match('{')) {
                // import {bar}
                specifiers = specifiers.concat(parseNamedImports());
            } else if (match('*')) {
                // import * as foo
                specifiers.push(parseImportNamespaceSpecifier());
            } else if (isIdentifierName(lookahead) && !matchKeyword('default')) {
                // import foo
                specifiers.push(parseImportDefaultSpecifier());
                if (match(',')) {
                    lex();
                    if (match('*')) {
                        // import foo, * as foo
                        specifiers.push(parseImportNamespaceSpecifier());
                    } else if (match('{')) {
                        // import foo, {bar}
                        specifiers = specifiers.concat(parseNamedImports());
                    } else {
                        throwUnexpectedToken(lookahead);
                    }
                }
            } else {
                throwUnexpectedToken(lex());
            }

            if (!matchContextualKeyword('from')) {
                throwError(lookahead.value ?
                        Messages.UnexpectedToken : Messages.MissingFromClause, lookahead.value);
            }
            lex();
            src = parseModuleSpecifier();
        }

        consumeSemicolon();
        return node.finishImportDeclaration(specifiers, src);
    }

    // ECMA-262 15.1 Scripts

    function parseScriptBody() {
        var statement, body = [], token, directive, firstRestricted;

        while (startIndex < length) {
            token = lookahead;
            if (token.type !== Token.StringLiteral) {
                break;
            }

            statement = parseStatementListItem();
            body.push(statement);
            if (statement.expression.type !== Syntax.Literal) {
                // this is not directive
                break;
            }
            directive = source.slice(token.start + 1, token.end - 1);
            if (directive === 'use strict') {
                strict = true;
                if (firstRestricted) {
                    tolerateUnexpectedToken(firstRestricted, Messages.StrictOctalLiteral);
                }
            } else {
                if (!firstRestricted && token.octal) {
                    firstRestricted = token;
                }
            }
        }

        while (startIndex < length) {
            statement = parseStatementListItem();
            /* istanbul ignore if */
            if (typeof statement === 'undefined') {
                break;
            }
            body.push(statement);
        }
        return body;
    }

    function parseProgram() {
        var body, node;

        peek();
        node = new Node();

        body = parseScriptBody();
        return node.finishProgram(body, state.sourceType);
    }

    function filterTokenLocation() {
        var i, entry, token, tokens = [];

        for (i = 0; i < extra.tokens.length; ++i) {
            entry = extra.tokens[i];
            token = {
                type: entry.type,
                value: entry.value
            };
            if (entry.regex) {
                token.regex = {
                    pattern: entry.regex.pattern,
                    flags: entry.regex.flags
                };
            }
            if (extra.range) {
                token.range = entry.range;
            }
            if (extra.loc) {
                token.loc = entry.loc;
            }
            tokens.push(token);
        }

        extra.tokens = tokens;
    }

    function tokenize(code, options, delegate) {
        var toString,
            tokens;

        toString = String;
        if (typeof code !== 'string' && !(code instanceof String)) {
            code = toString(code);
        }

        source = code;
        index = 0;
        lineNumber = (source.length > 0) ? 1 : 0;
        lineStart = 0;
        startIndex = index;
        startLineNumber = lineNumber;
        startLineStart = lineStart;
        length = source.length;
        lookahead = null;
        state = {
            allowIn: true,
            allowYield: true,
            labelSet: {},
            inFunctionBody: false,
            inIteration: false,
            inSwitch: false,
            lastCommentStart: -1,
            curlyStack: []
        };

        extra = {};

        // Options matching.
        options = options || {};

        // Of course we collect tokens here.
        options.tokens = true;
        extra.tokens = [];
        extra.tokenValues = [];
        extra.tokenize = true;
        extra.delegate = delegate;

        // The following two fields are necessary to compute the Regex tokens.
        extra.openParenToken = -1;
        extra.openCurlyToken = -1;

        extra.range = (typeof options.range === 'boolean') && options.range;
        extra.loc = (typeof options.loc === 'boolean') && options.loc;

        if (typeof options.comment === 'boolean' && options.comment) {
            extra.comments = [];
        }
        if (typeof options.tolerant === 'boolean' && options.tolerant) {
            extra.errors = [];
        }

        try {
            peek();
            if (lookahead.type === Token.EOF) {
                return extra.tokens;
            }

            lex();
            while (lookahead.type !== Token.EOF) {
                try {
                    lex();
                } catch (lexError) {
                    if (extra.errors) {
                        recordError(lexError);
                        // We have to break on the first error
                        // to avoid infinite loops.
                        break;
                    } else {
                        throw lexError;
                    }
                }
            }

            tokens = extra.tokens;
            if (typeof extra.errors !== 'undefined') {
                tokens.errors = extra.errors;
            }
        } catch (e) {
            throw e;
        } finally {
            extra = {};
        }
        return tokens;
    }

    function parse(code, options) {
        var program, toString;

        toString = String;
        if (typeof code !== 'string' && !(code instanceof String)) {
            code = toString(code);
        }

        source = code;
        index = 0;
        lineNumber = (source.length > 0) ? 1 : 0;
        lineStart = 0;
        startIndex = index;
        startLineNumber = lineNumber;
        startLineStart = lineStart;
        length = source.length;
        lookahead = null;
        state = {
            allowIn: true,
            allowYield: true,
            labelSet: {},
            inFunctionBody: false,
            inIteration: false,
            inSwitch: false,
            lastCommentStart: -1,
            curlyStack: [],
            sourceType: 'script'
        };
        strict = false;

        extra = {};
        if (typeof options !== 'undefined') {
            extra.range = (typeof options.range === 'boolean') && options.range;
            extra.loc = (typeof options.loc === 'boolean') && options.loc;
            extra.attachComment = (typeof options.attachComment === 'boolean') && options.attachComment;

            if (extra.loc && options.source !== null && options.source !== undefined) {
                extra.source = toString(options.source);
            }

            if (typeof options.tokens === 'boolean' && options.tokens) {
                extra.tokens = [];
            }
            if (typeof options.comment === 'boolean' && options.comment) {
                extra.comments = [];
            }
            if (typeof options.tolerant === 'boolean' && options.tolerant) {
                extra.errors = [];
            }
            if (extra.attachComment) {
                extra.range = true;
                extra.comments = [];
                extra.bottomRightStack = [];
                extra.trailingComments = [];
                extra.leadingComments = [];
            }
            if (options.sourceType === 'module') {
                // very restrictive condition for now
                state.sourceType = options.sourceType;
                strict = true;
            }
        }

        try {
            program = parseProgram();
            if (typeof extra.comments !== 'undefined') {
                program.comments = extra.comments;
            }
            if (typeof extra.tokens !== 'undefined') {
                filterTokenLocation();
                program.tokens = extra.tokens;
            }
            if (typeof extra.errors !== 'undefined') {
                program.errors = extra.errors;
            }
        } catch (e) {
            throw e;
        } finally {
            extra = {};
        }

        return program;
    }

    // Sync with *.json manifests.
    exports.version = '2.7.2';

    exports.tokenize = tokenize;

    exports.parse = parse;

    // Deep copy.
    /* istanbul ignore next */
    exports.Syntax = (function () {
        var name, types = {};

        if (typeof Object.create === 'function') {
            types = Object.create(null);
        }

        for (name in Syntax) {
            if (Syntax.hasOwnProperty(name)) {
                types[name] = Syntax[name];
            }
        }

        if (typeof Object.freeze === 'function') {
            Object.freeze(types);
        }

        return types;
    }());

}));
/* vim: set sw=4 ts=4 et tw=80 : */

});
$rmod.def("/marko@3.3.0/compiler/util/parseJavaScript", function(require, exports, module, __filename, __dirname) { 'use strict';
var ok = require('/$/assert'/*'assert'*/).ok;

const esprima = require('/$/esprima'/*'esprima'*/);

function parseExpression(src, builder, isExpression) {
    ok(typeof src === 'string', '"src" should be a string expression');
    ok(builder, '"builder" is required');

    function convert(node) {

        if (Array.isArray(node)) {
            let nodes = node;
            for (let i=0; i<nodes.length; i++) {
                var converted = convert(nodes[i]);
                if (converted == null) {
                    return null;
                }
                nodes[i] = converted;
            }
            return nodes;
        }

        switch(node.type) {
            case 'ArrayExpression': {
                let elements = convert(node.elements);
                if (!elements) {
                    return null;
                }
                return builder.arrayExpression(elements);
            }
            case 'AssignmentExpression': {
                let left = convert(node.left);
                if (!left) {
                    return null;
                }

                let right = convert(node.right);
                if (!right) {
                    return null;
                }

                return builder.assignment(left, right, node.operator);
            }
            case 'BinaryExpression': {
                let left = convert(node.left);
                if (!left) {
                    return null;
                }

                let right = convert(node.right);
                if (!right) {
                    return null;
                }

                return builder.binaryExpression(left, node.operator, right);
            }
            case 'CallExpression': {
                let callee = convert(node.callee);

                if (!callee) {
                    return null;
                }

                let args = convert(node.arguments);
                if (!args) {
                    return null;
                }

                return builder.functionCall(callee, args);
            }
            case 'ConditionalExpression': {
                let test = convert(node.test);

                if (!test) {
                    return null;
                }

                let consequent = convert(node.consequent);

                if (!consequent) {
                    return null;
                }

                let alternate = convert(node.alternate);

                if (!alternate) {
                    return null;
                }

                return builder.conditionalExpression(test, consequent, alternate);
            }
            case 'ExpressionStatement': {
                return convert(node.expression);
            }
            case 'FunctionDeclaration':
            case 'FunctionExpression': {
                let name = null;

                if (node.id) {
                    name = convert(node.id);
                    if (name == null) {
                        return null;
                    }
                }

                let params = convert(node.params);
                if (!params) {
                    return null;
                }

                let body = convert(node.body);
                if (!body) {
                    return null;
                }

                return builder.functionDeclaration(name, params, body);
            }
            case 'Identifier': {
                return builder.identifier(node.name);
            }
            case 'Literal': {
                return builder.literal(node.value);
            }
            case 'LogicalExpression': {
                let left = convert(node.left);
                if (!left) {
                    return null;
                }

                let right = convert(node.right);
                if (!right) {
                    return null;
                }

                return builder.logicalExpression(left, node.operator, right);
            }
            case 'MemberExpression': {
                let object = convert(node.object);
                if (!object) {
                    return null;
                }

                let property = convert(node.property);
                if (!property) {
                    return null;
                }

                return builder.memberExpression(object, property, node.computed);
            }
            case 'NewExpression': {
                let callee = convert(node.callee);

                if (!callee) {
                    return null;
                }

                let args = convert(node.arguments);
                if (!args) {
                    return null;
                }

                return builder.newExpression(callee, args);
            }
            case 'Program': {
                if (node.body && node.body.length === 1) {
                    return convert(node.body[0]);
                }
                return null;
            }
            case 'ObjectExpression': {
                let properties = convert(node.properties);
                if (!properties) {
                    return null;
                }
                return builder.objectExpression(properties);
            }
            case 'Property': {
                let key = convert(node.key);
                if (!key) {
                    return null;
                }
                let value = convert(node.value);
                if (!value) {
                    return null;
                }
                return builder.property(key, value);
            }
            case 'ThisExpression': {
                return builder.thisExpression();
            }
            case 'UnaryExpression': {
                let argument = convert(node.argument);
                if (!argument) {
                    return null;
                }

                return builder.unaryExpression(argument, node.operator, node.prefix);
            }
            case 'UpdateExpression': {
                let argument = convert(node.argument);
                if (!argument) {
                    return null;
                }

                return builder.updateExpression(argument, node.operator, node.prefix);
            }
            default:
                return null;
        }
    }

    let jsAST;
    try {
        if (isExpression) {
            src = '(' + src + ')';
        }
        jsAST = esprima.parse(src);
    } catch(e) {
        if (e.index == null) {
            // Doesn't look like an Esprima parse error... just rethrow the exception
            throw e;
        }
        var errorIndex = e.index;
        var errorMessage = '\n' + e.description;
        if (errorIndex != null && errorIndex >= 0) {
            if (isExpression) {
                errorIndex--; // Account for extra paren added to start
            }
            errorMessage += ': ';
            errorMessage += src + '\n'+ new Array(errorMessage.length + errorIndex + 1).join(" ") + '^';
        }
        var wrappedError = new Error(errorMessage);
        wrappedError.index = errorIndex;
        wrappedError.src = src;
        wrappedError.code = 'ERR_INVALID_JAVASCRIPT_EXPRESSION';
        throw wrappedError;
    }

    var converted = convert(jsAST);
    if (converted == null) {
        converted = builder.expression(src);
    }

    return converted;
}

module.exports = parseExpression;

});
$rmod.def("/marko@3.3.0/compiler/util/parseExpression", function(require, exports, module, __filename, __dirname) { var parseJavaScript = require('./parseJavaScript');

module.exports = function(src, builder) {
    return parseJavaScript(src, builder, true /* isExpression */ );
};
});
$rmod.def("/marko@3.3.0/compiler/util/parseStatement", function(require, exports, module, __filename, __dirname) { var parseJavaScript = require('./parseJavaScript');

module.exports = function(src, builder) {
    return parseJavaScript(src, builder, false /* isExpression */ );
};
});
$rmod.def("/marko@3.3.0/compiler/util/parseJavaScriptArgs", function(require, exports, module, __filename, __dirname) { 'use strict';

var ok = require('/$/assert'/*'assert'*/).ok;

function parseJavaScriptArgs(args, builder) {
    ok(typeof args === 'string', '"args" should be a string');
    ok(builder, '"builder" is required');

    var parsed = builder.parseExpression('[' + args + ']');
    return parsed.elements;
}

module.exports = parseJavaScriptArgs;
});
$rmod.def("/marko@3.3.0/compiler/util/isValidJavaScriptIdentifier", function(require, exports, module, __filename, __dirname) { var idRegExp = /^[$A-Z_][0-9A-Z_$]*$/i;

module.exports = function isValidJavaScriptIdentifier(varName) {
    return idRegExp.test(varName);
};

});
$rmod.def("/marko@3.3.0/compiler/Builder", function(require, exports, module, __filename, __dirname) { 'use strict';
var isArray = Array.isArray;
var ok = require('/$/assert'/*'assert'*/).ok;

var Node = require('./ast/Node');
var Program = require('./ast/Program');
var TemplateRoot = require('./ast/TemplateRoot');
var FunctionDeclaration = require('./ast/FunctionDeclaration');
var FunctionCall = require('./ast/FunctionCall');
var Literal = require('./ast/Literal');
var Identifier = require('./ast/Identifier');
var If = require('./ast/If');
var ElseIf = require('./ast/ElseIf');
var Else = require('./ast/Else');
var Assignment = require('./ast/Assignment');
var BinaryExpression = require('./ast/BinaryExpression');
var LogicalExpression = require('./ast/LogicalExpression');
var Vars = require('./ast/Vars');
var Return = require('./ast/Return');
var HtmlElement = require('./ast/HtmlElement');
var Html = require('./ast/Html');
var Text = require('./ast/Text');
var ForEach = require('./ast/ForEach');
var ForEachProp = require('./ast/ForEachProp');
var ForRange = require('./ast/ForRange');
var Slot = require('./ast/Slot');
var HtmlComment = require('./ast/HtmlComment');
var SelfInvokingFunction = require('./ast/SelfInvokingFunction');
var ForStatement = require('./ast/ForStatement');
var BinaryExpression = require('./ast/BinaryExpression');
var UpdateExpression = require('./ast/UpdateExpression');
var UnaryExpression = require('./ast/UnaryExpression');
var MemberExpression = require('./ast/MemberExpression');
var Code = require('./ast/Code');
var InvokeMacro = require('./ast/InvokeMacro');
var Macro = require('./ast/Macro');
var ConditionalExpression = require('./ast/ConditionalExpression');
var NewExpression = require('./ast/NewExpression');
var ObjectExpression = require('./ast/ObjectExpression');
var ArrayExpression = require('./ast/ArrayExpression');
var Property = require('./ast/Property');
var VariableDeclarator = require('./ast/VariableDeclarator');
var ThisExpression = require('./ast/ThisExpression');
var Expression = require('./ast/Expression');
var Scriptlet = require('./ast/Scriptlet');
var ContainerNode = require('./ast/ContainerNode');
var WhileStatement = require('./ast/WhileStatement');
var DocumentType = require('./ast/DocumentType');
var Declaration = require('./ast/Declaration');

var parseExpression = require('./util/parseExpression');
var parseStatement = require('./util/parseStatement');
var parseJavaScriptArgs = require('./util/parseJavaScriptArgs');
var isValidJavaScriptIdentifier = require('./util/isValidJavaScriptIdentifier');

var DEFAULT_BUILDER;

function makeNode(arg) {
    if (typeof arg === 'string') {
        return parseExpression(arg, DEFAULT_BUILDER);
    } else if (arg instanceof Node) {
        return arg;
    } else if (arg == null) {
        return undefined;
    } else {
        throw new Error('Argument should be a string or Node or null. Actual: ' + arg);
    }
}

var literalNull = new Literal({value: null});
var literalUndefined = new Literal({value: null});
var literalTrue = new Literal({value: true});
var literalFalse = new Literal({value: true});
var identifierOut = new Identifier({name: 'out'});

class Builder {
    arrayExpression(elements) {
        if (elements) {
            if (!isArray(elements)) {
                elements = [elements];
            }

            for (var i=0; i<elements.length; i++) {
                elements[i] = makeNode(elements[i]);
            }
        } else {
            elements = [];
        }

        return new ArrayExpression({elements});
    }

    assignment(left, right, operator) {
        if (operator == null) {
            operator = '=';
        }
        left = makeNode(left);
        right = makeNode(right);
        return new Assignment({left, right, operator});
    }

    binaryExpression(left, operator, right) {
        left = makeNode(left);
        right = makeNode(right);
        return new BinaryExpression({left, operator, right});
    }

    code(value) {
        return new Code({value});
    }

    computedMemberExpression(object, property) {
        object = makeNode(object);
        property = makeNode(property);
        let computed = true;

        return new MemberExpression({object, property, computed});
    }

    concat(args) {
        var prev;
        let operator = '+';

        for (var i=1; i<arguments.length; i++) {
            var left;
            var right = makeNode(arguments[i]);
            if (i === 1) {
                left = makeNode(arguments[i-1]);
            } else {
                left = prev;
            }

            prev = new BinaryExpression({left, operator, right});
        }

        return prev;
    }

    conditionalExpression(test, consequent, alternate) {
        return new ConditionalExpression({test, consequent, alternate});
    }

    containerNode(type, generateCode) {
        if (typeof type === 'function') {
            generateCode = arguments[0];
            type = 'ContainerNode';
        }

        var node = new ContainerNode(type);
        if (generateCode) {
            node.setCodeGenerator(generateCode);
        }
        return node;
    }

    declaration(declaration) {
        return new Declaration({declaration});
    }

    documentType(documentType) {
        return new DocumentType({documentType});
    }

    elseStatement(body) {
        return new Else({body});
    }

    elseIfStatement(test, body, elseStatement) {
        test = makeNode(test);

        return new ElseIf({test, body, else: elseStatement});
    }

    expression(value) {
        return new Expression({value});
    }

    forEach(varName, inExpression, body) {
        if (arguments.length === 1) {
            var def = arguments[0];
            return new ForEach(def);
        } else {
            varName = makeNode(varName);
            inExpression = makeNode(inExpression);
            return new ForEach({varName, in: inExpression, body});
        }
    }

    forEachProp(nameVarName, valueVarName, inExpression, body) {
        if (arguments.length === 1) {
            var def = arguments[0];
            return new ForEachProp(def);
        } else {
            nameVarName = makeNode(nameVarName);
            valueVarName = makeNode(valueVarName);
            inExpression = makeNode(inExpression);
            return new ForEachProp({nameVarName, valueVarName, in: inExpression, body});
        }
    }

    forRange(varName, from, to, step, body) {
        if (arguments.length === 1) {
            var def = arguments[0];
            return new ForRange(def);
        } else {
            varName = makeNode(varName);
            from = makeNode(from);
            to = makeNode(to);
            step = makeNode(step);
            body = makeNode(body);

            return new ForRange({varName, from, to, step, body});
        }
    }

    forStatement(init, test, update, body) {
        if (arguments.length === 1) {
            var def = arguments[0];
            return new ForStatement(def);
        } else {
            init = makeNode(init);
            test = makeNode(test);
            update = makeNode(update);
            return new ForStatement({init, test, update, body});
        }
    }

    functionCall(callee, args) {
        callee = makeNode(callee);

        if (args) {
            if (!isArray(args)) {
                throw new Error('"args" should be an array');
            }

            for (var i=0; i<args.length; i++) {
                args[i] = makeNode(args[i]);
            }
        } else {
            args = [];
        }

        return new FunctionCall({callee, args});
    }

    functionDeclaration(name, params, body) {
        return new FunctionDeclaration({name, params, body});
    }

    html(argument) {
        argument = makeNode(argument);

        return new Html({argument});
    }

    htmlComment(comment) {
        return new HtmlComment({comment});
    }

    htmlElement(tagName, attributes, body, argument, openTagOnly, selfClosed) {
        if (typeof tagName === 'object' && !(tagName instanceof Node)) {
            let def = arguments[0];
            return new HtmlElement(def);
        } else {
            return new HtmlElement({tagName, attributes, body, argument, openTagOnly, selfClosed});
        }
    }

    identifier(name) {
        ok(typeof name === 'string', '"name" should be a string');

        if (!isValidJavaScriptIdentifier(name)) {
            var error = new Error('Invalid JavaScript identifier: ' + name);
            error.code = 'INVALID_IDENTIFIER';
            throw error;
        }
        return new Identifier({name});
    }

    identifierOut(name) {
        return identifierOut;
    }

    ifStatement(test, body, elseStatement) {
        test = makeNode(test);

        return new If({test, body, else: elseStatement});
    }

    invokeMacro(name, args, body) {
        return new InvokeMacro({name, args, body});
    }

    invokeMacroFromEl(el) {
        return new InvokeMacro({el});
    }

    literal(value) {
        return new Literal({value});
    }

    literalFalse() {
        return literalFalse;
    }

    literalNull() {
        return literalNull;
    }

    literalTrue() {
        return literalTrue;
    }

    literalUndefined() {
        return literalUndefined;
    }

    logicalExpression(left, operator, right) {
        left = makeNode(left);
        right = makeNode(right);
        return new LogicalExpression({left, operator, right});
    }

    macro(name, params, body) {
        return new Macro({name, params, body});
    }

    memberExpression(object, property, computed) {
        object = makeNode(object);
        property = makeNode(property);

        return new MemberExpression({object, property, computed});
    }

    negate(argument) {
        argument = makeNode(argument);

        var operator = '!';
        var prefix = true;
        return new UnaryExpression({argument, operator, prefix});
    }

    newExpression(callee, args) {
        callee = makeNode(callee);

        if (args) {
            if (!isArray(args)) {
                args = [args];
            }

            for (var i=0; i<args.length; i++) {
                args[i] = makeNode(args[i]);
            }
        } else {
            args = [];
        }

        return new NewExpression({callee, args});
    }

    node(type, generateCode) {
        if (typeof type === 'function') {
            generateCode = arguments[0];
            type = 'Node';
        }

        var node = new Node(type);
        if (generateCode) {
            node.setCodeGenerator(generateCode);
        }
        return node;
    }

    objectExpression(properties) {
        if (properties) {
            if (!isArray(properties)) {
                properties = [properties];
            }

            for (var i=0; i<properties.length; i++) {
                let prop = properties[i];
                prop.value = makeNode(prop.value);
            }
        } else {
            properties = [];
        }

        return new ObjectExpression({properties});
    }

    parseExpression(str, options) {
        ok(typeof str === 'string', '"str" should be a string expression');
        var parsed = parseExpression(str, DEFAULT_BUILDER);
        return parsed;
    }

    parseJavaScriptArgs(args) {
        ok(typeof args === 'string', '"args" should be a string');
        return parseJavaScriptArgs(args, DEFAULT_BUILDER);
    }

    parseStatement(str, options) {
        ok(typeof str === 'string', '"str" should be a string expression');
        var parsed = parseStatement(str, DEFAULT_BUILDER);
        return parsed;
    }

    program(body) {
        return new Program({body});
    }

    property(key, value) {
        key = makeNode(key);
        value = makeNode(value);

        return new Property({key, value});
    }

    renderBodyFunction(body) {
        let name = 'renderBody';
        let params = [new Identifier({name: 'out'})];
        return new FunctionDeclaration({name, params, body});
    }

    require(path) {
        path = makeNode(path);

        let callee = 'require';
        let args = [ path ];
        return new FunctionCall({callee, args});
    }

    requireResolve(path) {
        path = makeNode(path);

        let callee = new MemberExpression({
            object: new Identifier({name: 'require'}),
            property: new Identifier({name: 'resolve'})
        });

        let args = [ path ];
        return new FunctionCall({callee, args});
    }

    returnStatement(argument) {
        argument = makeNode(argument);

        return new Return({argument});
    }

    scriptlet(code) {
        return new Scriptlet({code});
    }

    selfInvokingFunction(params, args, body) {
        if (arguments.length === 1) {
            body = arguments[0];
            params = null;
            args = null;
        }

        return new SelfInvokingFunction({params, args, body});
    }

    slot(onDone) {
        return new Slot({onDone});
    }

    strictEquality(left, right) {
        left = makeNode(left);
        right = makeNode(right);

        var operator = '===';
        return new BinaryExpression({left, right, operator});
    }

    templateRoot(body) {
        return new TemplateRoot({body});
    }

    text(argument, escape, preserveWhitespace) {
        if (typeof argument === 'object' && !(argument instanceof Node)) {
            var def = arguments[0];
            return new Text(def);
        }
        argument = makeNode(argument);

        return new Text({argument, escape, preserveWhitespace});
    }

    thisExpression() {
        return new ThisExpression();
    }

    unaryExpression(argument, operator, prefix) {
        argument = makeNode(argument);

        return new UnaryExpression({argument, operator, prefix});
    }

    updateExpression(argument, operator, prefix) {
        argument = makeNode(argument);
        return new UpdateExpression({argument, operator, prefix});
    }

    variableDeclarator(id, init) {
        if (typeof id === 'string') {
            id = new Identifier({name: id});
        }
        if (init) {
            init = makeNode(init);
        }

        return new VariableDeclarator({id, init});
    }

    var(id, init, kind) {
        if (!kind) {
            kind = 'var';
        }

        id = makeNode(id);
        init = makeNode(init);

        var declarations = [
            new VariableDeclarator({id, init})
        ];

        return new Vars({declarations, kind});
    }

    vars(declarations, kind) {
        if (declarations) {
            if (Array.isArray(declarations)) {
                for (let i=0; i<declarations.length; i++) {
                    var declaration = declarations[i];
                    if (!declaration) {
                        throw new Error('Invalid variable declaration');
                    }
                    if (typeof declaration === 'string') {
                        declarations[i] = new VariableDeclarator({
                            id: new Identifier({name: declaration})
                        });
                    } else if (declaration instanceof Identifier) {
                        declarations[i] = new VariableDeclarator({
                            id: declaration
                        });
                    } else if (typeof declaration === 'object') {
                        if (!(declaration instanceof VariableDeclarator)) {
                            let id = declaration.id;
                            let init = declaration.init;

                            if (typeof id === 'string') {
                                id = new Identifier({name: id});
                            }

                            if (!id) {
                                throw new Error('Invalid variable declaration');
                            }

                            if (init) {
                                init = makeNode(init);
                            }


                            declarations[i] = new VariableDeclarator({id, init});
                        }
                    }
                }
            } else if (typeof declarations === 'object') {
                // Convert the object into an array of variables
                declarations = Object.keys(declarations).map((key) => {
                    let id = new Identifier({name: key});
                    let init = makeNode(declarations[key]);
                    return new VariableDeclarator({ id, init });
                });
            }
        }


        return new Vars({declarations, kind});
    }

    whileStatement(test, body) {
        return new WhileStatement({test, body});
    }
}

DEFAULT_BUILDER = new Builder();

Builder.DEFAULT_BUILDER = DEFAULT_BUILDER;

module.exports = Builder;

});
$rmod.main("/path-browserify@0.0.0", "index");
$rmod.dep("", "path-browserify", "0.0.0", "path");
$rmod.dep("", "path-browserify", "0.0.0");
$rmod.def("/path-browserify@0.0.0/index", function(require, exports, module, __filename, __dirname) { var process=require("process"); // Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// Split a filename into [root, dir, basename, ext], unix version
// 'root' is just a slash, or nothing.
var splitPathRe =
    /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
var splitPath = function(filename) {
  return splitPathRe.exec(filename).slice(1);
};

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function(path) {
  var result = splitPath(path),
      root = result[0],
      dir = result[1];

  if (!root && !dir) {
    // No dirname whatsoever
    return '.';
  }

  if (dir) {
    // It has a dirname, strip trailing slash
    dir = dir.substr(0, dir.length - 1);
  }

  return root + dir;
};


exports.basename = function(path, ext) {
  var f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};


exports.extname = function(path) {
  return splitPath(path)[3];
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

});
$rmod.main("/char-props@0.1.5", "lib/charProps");
$rmod.dep("", "char-props", "0.1.5");
$rmod.def("/char-props@0.1.5/lib/charProps", function(require, exports, module, __filename, __dirname) { /**
 * Indexer constructor (takes index and performs pre-emptive caching)
 * @constructor
 * @param {String} input Content to index
 */
function Indexer(input) {
  this.input = input;

  // Break up lines by line breaks
  var lines = input.split('\n');

  // Iterate over the lines until we reach the end or we hit our index
  var i = 0,
      len = lines.length,
      line,
      lineStart = 0,
      lineEnd,
      lineMap = {'length': len};
  for (; i < len; i++) {
    // Grab the line
    line = lines[i];

    // Calculate the line end (includes \n we removed)
    lineEnd = lineStart + line.length + 1;

    // Save the line to its map
    lineMap[i] = {'start': lineStart, 'end': lineEnd};

    // Overwrite lineStart with lineEnd
    lineStart = lineEnd;
  }

  // Save the lineMap to this
  this.lineMap = lineMap;
}
Indexer.prototype = {
  /**
   * Get the line of the character at a certain index
   * @param {Number} index Index of character to retrieve line of
   * @param {Object} [options] Options to use for search
   * @param {Number} [options.minLine=0] Minimum line for us to search on
   * TODO: The following still have to be built/implemented
   * @param {Number} [options.maxLine=lines.length] Maximum line for us to search on
   * @param {String} [options.guess="average"] Affects searching pattern -- can be "high", "low", or "average" (linear top-down, linear bottom-up, or binary)
   * @returns {Number} Line number of character
   */
  'lineAt': function (index, options) {
    // Fallback options
    options = options || {};

    // TODO: We can binary search here
    // Grab the line map and iterate over it
    var lineMap = this.lineMap,
        i = options.minLine || 0,
        len = lineMap.length,
        lineItem;

    for (; i < len; i++) {
      // TODO: If binary searching, this requires both above and below
      // If the index is under end of the lineItem, stop
      lineItem = lineMap[i];

      if (index < lineItem.end) {
        break;
      }
    }

    // Return the line we stopped on
    return i;
  },
  /**
   * Get the column of the character at a certain index
   * @param {Number} index Index of character to retrieve column of
   * @returns {Number} Column number of character
   */
  'columnAt': function (index) {
    // Start at the index - 1
    var input = this.input,
        char,
        i = index - 1;

    // If the index is negative, return now
    if (index < 0) {
      return 0;
    }

    // Continue left until index < 0 or we hit a line break
    for (; i >= 0; i--) {
      char = input.charAt(i);
      if (char === '\n') {
        break;
      }
    }

    // Return the col of our index - 1 (line break is not in the column count)
    var col = index - i - 1;
    return col;
  },
  /**
   * Get the index of the character at a line and column
   * @param {Object} params Object containing line and column
   * @param {Number} params.line Line of character
   * @param {Number} params.column Column of character
   * @returns {Number} Index of character
   */
  'indexAt': function (params) {
    // Grab the parameters and lineMap
    var line = params.line,
        column = params.column,
        lineMap = this.lineMap;

    // Go to the nth line and get the start
    var retLine = lineMap[line],
        lineStart = retLine.start;

    // Add on the column to the line start and return
    var retVal = lineStart + column;
    return retVal;
  },
  /**
   * Get the character at a line and column
   * @param {Object} params Object containing line and column
   * @param {Number} params.line Line of character
   * @param {Number} params.column Column of character
   * @returns {String} Character at specified location
   */
  'charAt': function (params) {
    // Get the index of the character, look it up, and return
    var index = this.indexAt(params),
        input = this.input,
        retVal = input.charAt(index);
    return retVal;
  }
};

function charProps(input) {
  // Create and return a new Indexer with the content
  var indexer = new Indexer(input);
  return indexer;
}

// Expose Indexer to charProps
charProps.Indexer = Indexer;

// Export charProps
module.exports = charProps;
});
$rmod.remap("/marko@3.3.0/compiler/util/deresolve", "deresolve-browser");
$rmod.def("/marko@3.3.0/compiler/util/deresolve-browser", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
* 
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
* 
*    http://www.apache.org/licenses/LICENSE-2.0
* 
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

module.exports = function(resolvedPath, from) {
    return resolvedPath;
};
});
$rmod.def("/marko@3.3.0/compiler/util/safeVarName", function(require, exports, module, __filename, __dirname) { function safeVarName(varName) {
    var parts = varName.split(/[\\/]/);
    if (parts.length >= 2) {
        // The varname looks like it was based on a path.
        // Let's just use the last two parts
        varName = parts.slice(-2).join('_');
    }

    return varName.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[0-9]+/, function(match) {
        var str = '';
        for (var i=0; i<match.length; i++) {
            str += '_';
        }
        return str;
    });
}

module.exports = safeVarName;
});
$rmod.def("/marko@3.3.0/compiler/util/UniqueVars", function(require, exports, module, __filename, __dirname) { 'use strict';

var safeVarName = require('./safeVarName');

class UniqueVars {
    constructor() {
        this.vars = {};
    }

    addVar(name, value) {
        if (typeof value !== 'string') {
            // Convert the non-string value into a string for easy comparison
            value = JSON.stringify(value);
        }

        name = safeVarName(name);

        var entry = this.vars[name];
        if (entry) {
            var vars = entry.vars;

            // See if there is already a variable with the requested value
            for (var i=0; i<vars.length; i++) {
                var curVar = vars[i];
                if (curVar.value === value) {
                    return curVar.name;
                }
            }

            entry.vars.push({
                name: name + (++entry.counter),
                value: value
            });
        } else {
            entry = {
                vars: [
                    {
                        name: name,
                        value: value
                    }
                ],
                counter: 1
            };

            this.vars[name] = entry;
        }

        return name;
    }
}

module.exports = UniqueVars;
});
$rmod.def("/marko@3.3.0/compiler/util/PosInfo", function(require, exports, module, __filename, __dirname) { 'use strict';var process=require("process"); 

var path = require('path-browserify'/*'path'*/);

function getRelativePath(absolutePath) {
    if (typeof window === 'undefined') {
        absolutePath = path.resolve(process.cwd(), absolutePath);
        return path.relative(process.cwd(), absolutePath);
    } else {
        return absolutePath;
    }
}

class PosInfo {
    constructor(path, line, column) {
        this.path = getRelativePath(path);
        this.line = line;
        this.column = column;
    }

    toString() {
        return this.path + ":" + this.line + ":" + this.column;
    }
}

module.exports = PosInfo;
});
$rmod.def("/marko@3.3.0/compiler/CompileError", function(require, exports, module, __filename, __dirname) { 'use strict';

class CompileError {
    constructor(errorInfo, context) {
        this.context = context;
        this.node = errorInfo.node;
        this.message = errorInfo.message;
        this.code = errorInfo.code;

        var pos = errorInfo.pos;
        var endPos = errorInfo.endPos;

        if (pos == null) {
            pos = this.node && this.node.pos;
        }

        if (endPos == null) {
            endPos = this.node && this.node.endPos;
        }

        if (pos != null) {
            pos = context.getPosInfo(pos);
        }

        if (endPos != null) {
            endPos = context.getPosInfo(endPos);
        }

        this.pos = pos;
        this.endPos = endPos;
    }

    toString() {
        var pos = this.pos;
        if (pos) {
            pos = '[' + pos + '] ';
        } else {
            pos = '';
        }
        var str = pos + this.message;
        if (pos == null && this.node) {
            str += ' (' + this.node.toString() + ')';
        }
        return str;
    }
}

module.exports = CompileError;
});
$rmod.def("/marko@3.3.0/compiler/util/macros", function(require, exports, module, __filename, __dirname) { 'use strict';

var safeVarName = require('./safeVarName');
var ok = require('/$/assert'/*'assert'*/).ok;

class MacrosContext {
    constructor() {
        this._byName = {};
    }

    isMacro(name) {
        if (!name) {
            return false;
        }

        if (name.type === 'Literal') {
            name = name.value;
        }

        return this._byName.hasOwnProperty(name);
    }

    getRegisteredMacro(name) {
        return this._byName[name];
    }

    registerMacro(name, params) {
        ok(name, '"name" is required');
        ok(typeof name === 'string', '"name" should be a string');
        if (params == null) {
            params = [];

        } else {
            ok(Array.isArray(params), '"params" should be an array');
        }


        var hasOut = false;
        var hasRenderBody = false;
        params.forEach((param) => {
            if (param === 'out') {
                hasOut = true;
            } else if (param === 'renderBody') {
                hasRenderBody = true;
            }
        });

        if (!hasOut) {
            params.push('out');
        }

        if (!hasRenderBody) {
            params.push('renderBody');
        }

        var paramIndexes = {};
        params.forEach((param, i) => {
            paramIndexes[param] = i;

            if (param === 'out') {
                hasOut = true;
            } else if (param === 'renderBody') {
                hasRenderBody = true;
            }
        });

        var functionName = 'macro_' + safeVarName(name);

        var macroDef = {
            name: name,
            params: params,
            functionName: functionName,
            getParamIndex: function(param) {
                return paramIndexes[param];
            }
        };

        this._byName[name] = macroDef;

        return macroDef;
    }
}

function createMacrosContext() {
    return new MacrosContext();
}

exports.createMacrosContext = createMacrosContext;
});
$rmod.def("/marko@3.3.0/compiler/CompileContext", function(require, exports, module, __filename, __dirname) { 'use strict';var process=require("process"); 

var ok = require('/$/assert'/*'assert'*/).ok;
var path = require('path-browserify'/*'path'*/);
var taglibLookup = require('./taglib-lookup');
var charProps = require('/$/char-props'/*'char-props'*/);
var deresolve = require('./util/deresolve');
var UniqueVars = require('./util/UniqueVars');
var PosInfo = require('./util/PosInfo');
var CompileError = require('./CompileError');
var path = require('path-browserify'/*'path'*/);
var Node = require('./ast/Node');
var macros = require('./util/macros');
var extend = require('/$/raptor-util/extend'/*'raptor-util/extend'*/);
var Walker = require('./Walker');

const deresolveOptions = {
    shouldRemoveExt(ext) {
        return ext === '.js' || ext === '.json' || ext === '.es6';
    }
};

function getTaglibPath(taglibPath) {
    if (typeof window === 'undefined') {
        return path.relative(process.cwd(), taglibPath);
    } else {
        return taglibPath;
    }
}

function removeExt(filename) {
    var ext = path.extname(filename);
    if (ext) {
        return filename.slice(0, 0 - ext.length);
    } else {
        return filename;
    }
}

function requireResolve(builder, path) {
    var requireResolveNode = builder.memberExpression(
        builder.identifier('require'),
        builder.identifier('resolve'));


    return builder.functionCall(requireResolveNode, [ path ]);
}

class CompileContext {
    constructor(src, filename, builder) {
        ok(typeof src === 'string', '"src" string is required');
        ok(filename, '"filename" is required');

        this.src = src;
        this.filename = filename;
        this.builder = builder;

        this.dirname = path.dirname(filename);
        this.taglibLookup = taglibLookup.buildLookup(this.dirname);
        this.data = {};

        this._vars = {};
        this._uniqueVars = new UniqueVars();
        this._staticVars = {};
        this._staticCode = null;
        this._uniqueStaticVars = new UniqueVars();
        this._srcCharProps = null;
        this._flags = {};
        this._errors = [];
        this._macros = null;
        this._preserveWhitespace = null;
        this._preserveComments = null;
    }

    getPosInfo(pos) {
        var srcCharProps = this._srcCharProps || (this._srcCharProps = charProps(this.src));
        let line = srcCharProps.lineAt(pos)+1;
        let column = srcCharProps.columnAt(pos);
        return new PosInfo(this.filename, line, column);
    }

    setFlag(name) {
        this._flags[name] = true;
    }

    clearFlag(name) {
        delete this._flags[name];
    }

    isFlagSet(name) {
        return this._flags.hasOwnProperty(name);
    }

    addError(errorInfo) {
        if (errorInfo instanceof Node) {
            let node = arguments[0];
            let message = arguments[1];
            let code = arguments[2];
            errorInfo = {
                node,
                message,
                code
            };
        } else if (typeof errorInfo === 'string') {
            let message = arguments[0];
            let code = arguments[1];
            errorInfo = {
                message,
                code
            };
        }
        this._errors.push(new CompileError(errorInfo, this));
    }

    hasErrors() {
        return this._errors.length !== 0;
    }

    getErrors() {
        return this._errors;
    }

    getRequirePath(targetFilename) {
        return deresolve(targetFilename, this.dirname, deresolveOptions);
    }

    importModule(varName, path) {
        if (typeof path !== 'string') {
            throw new Error('"path" should be a string');
        }

        return this.addStaticVar(varName, 'require("' + path + '")');
    }


    addVar(name, init) {
        var actualVarName = this._uniqueVars.addVar(name, init);
        this._vars[actualVarName] = init;
        return this.builder.identifier(actualVarName);
    }

    getVars() {
        return this._vars;
    }

    addStaticVar(name, init) {
        var actualVarName = this._uniqueStaticVars.addVar(name, init);
        this._staticVars[actualVarName] = init;
        return this.builder.identifier(actualVarName);
    }

    getStaticVars() {
        return this._staticVars;
    }

    addStaticCode(code) {
        if (!code) {
            return;
        }

        if (typeof code === 'string') {
            // Wrap the String code in a Code AST node so that
            // the code will be indented properly
            code = this.builder.code(code);
        }

        if (this._staticCode == null) {
            this._staticCode = [code];
        } else {
            this._staticCode.push(code);
        }
    }

    getStaticCode() {
        return this._staticCode;
    }

    getEscapeXmlAttrVar() {
        return this.addStaticVar('escapeXmlAttr', '__helpers.xa');
    }

    getTagDef(tagName) {
        var taglibLookup = this.taglibLookup;

        if (typeof tagName === 'string') {
            return taglibLookup.getTag(tagName);
        } else {
            let elNode = tagName;
            if (elNode.tagDef) {
                return elNode.tagDef;
            }

            return taglibLookup.getTag(elNode.tagName);
        }
    }

    createNodeForEl(tagName, attributes, argument, openTagOnly, selfClosed) {
        var elDef;
        var builder = this.builder;

        if (typeof tagName === 'object') {
            elDef = tagName;
            tagName = elDef.tagName;
            attributes = elDef.attributes;
        } else {
            elDef = { tagName, argument, attributes, openTagOnly, selfClosed };
        }

        if (!attributes) {
            attributes = elDef.attributes = [];
        } else if (typeof attributes === 'object') {
            if (!Array.isArray(attributes)) {
                attributes = elDef.attributes = Object.keys(attributes).map((attrName) => {
                    var attrDef = {
                        name: attrName
                    };

                    var val = attributes[attrName];
                    if (val == null) {

                    } if (val instanceof Node) {
                        attrDef.value = val;
                    } else {
                        extend(attrDef, val);
                    }

                    return attrDef;
                });
            }
        } else {
            throw new Error('Invalid attributes');
        }

        var node;
        var elNode = builder.htmlElement(elDef);
        elNode.pos = elDef.pos;

        var taglibLookup = this.taglibLookup;
        var tagDef = typeof tagName === 'string' ? taglibLookup.getTag(tagName) : null;
        if (tagDef) {
            var nodeFactoryFunc = tagDef.getNodeFactory();
            if (nodeFactoryFunc) {
                var newNode = nodeFactoryFunc(elNode, this);
                if (!(newNode instanceof Node)) {
                    throw new Error('Invalid node returned from node factory for tag "' + tagName + '".');
                }

                if (newNode != node) {
                    // Make sure the body container is associated with the correct node
                    if (newNode.body && newNode.body !== node) {
                        newNode.body = newNode.makeContainer(newNode.body.items);
                    }
                    node = newNode;
                }
            }
        }

        if (!node) {
            node = elNode;
        }

        if (tagDef && tagDef.noOutput) {
            node.noOutput = true;
        }

        node.pos = elDef.pos;

        var foundAttrs = {};

        // Validate the attributes
        attributes.forEach((attr) => {
            let attrName = attr.name;
            if (!attrName) {
                // Attribute will be name for placeholder attributes. For example: <div ${data.myAttrs}>
                return;
            }
            let attrDef = taglibLookup.getAttribute(tagName, attrName);
            if (!attrDef) {
                if (tagDef) {
                    if (node.removeAttribute) {
                        node.removeAttribute(attrName);
                    }

                    // var isAttrForTaglib = compiler.taglibs.isTaglib(attrUri);
                    //Tag doesn't allow dynamic attributes
                    this.addError({
                        node: node,
                        message: 'The tag "' + tagName + '" in taglib "' + getTaglibPath(tagDef.taglibId) + '" does not support attribute "' + attrName + '"'
                    });

                }
                return;
            }

            if (attrDef.setFlag) {
                node.setFlag(attrDef.setFlag);
            }

            attr.def = attrDef;

            foundAttrs[attrName] = true;
        });

        if (tagDef) {
            // Add default values for any attributes. If an attribute has a declared
            // default value and the attribute was not found on the element
            // then add the attribute with the specified default value
            tagDef.forEachAttribute((attrDef) => {
                var attrName = attrDef.name;

                if (attrDef.hasOwnProperty('defaultValue') && !foundAttrs.hasOwnProperty(attrName)) {
                    attributes.push({
                        name: attrName,
                        value: builder.literal(attrDef.defaultValue)
                    });
                } else if (attrDef.required === true) {
                    // TODO Only throw an error if there is no data argument provided (just HTML attributes)
                    if (!foundAttrs.hasOwnProperty(attrName)) {
                        this.addError({
                            node: node,
                            message: 'The "' + attrName + '" attribute is required for tag "' + tagName + '" in taglib "' + getTaglibPath(tagDef.taglibId) + '".'
                        });
                    }
                }
            });

            node.tagDef = tagDef;
        }

        return node;
    }

    isMacro(name) {
        if (!this._macros) {
            return false;
        }

        return this._macros.isMacro(name);
    }

    getRegisteredMacro(name) {
        if (!this._macros) {
            return undefined;
        }

        return this._macros.getRegisteredMacro(name);
    }

    registerMacro(name, params) {
        if (!this._macros) {
            this._macros = macros.createMacrosContext();
        }

        return this._macros.registerMacro(name, params);
    }

    importTemplate(relativePath) {
        ok(typeof relativePath === 'string', '"path" should be a string');
        var builder = this.builder;


        // We want to add the following import:
        // var loadTemplate = __helpers.t;
        // var template = loadTemplate(require.resolve(<templateRequirePath>))

        var loadTemplateVar = this.addStaticVar('loadTemplate', '__helpers.l');
        var requireResolveTemplate = requireResolve(builder, builder.literal(relativePath));
        var loadFunctionCall = builder.functionCall(loadTemplateVar, [ requireResolveTemplate ]);
        var templateVar = this.addStaticVar(removeExt(relativePath), loadFunctionCall);
        return templateVar;
    }

    setPreserveWhitespace(preserveWhitespace) {
        this._preserveWhitespace = preserveWhitespace;
    }

    isPreserveWhitespace() {
        return this._preserveWhitespace === true;
    }

    setPreserveComments(preserveComments) {
        this._preserveComments = preserveComments;
    }

    isPreserveComments() {
        return this._preserveComments === true;
    }

    createWalker(options) {
        return new Walker(options);
    }

    /**
     * Statically resolves a path if it is a literal string. Otherwise, it returns the input expression.
     */
    resolvePath(pathExpression) {
        ok(pathExpression, '"pathExpression" is required');

        if (pathExpression.type === 'Literal') {
            let path = pathExpression.value;
            if (typeof path === 'string') {
                return this.addStaticVar(path, this.builder.requireResolve(pathExpression));
            }
        }
        return pathExpression;
    }

    resolveTemplate(pathExpression) {
        ok(pathExpression, '"pathExpression" is required');

        if (pathExpression.type === 'Literal') {
            let path = pathExpression.value;
            if (typeof path === 'string') {
                return this.importTemplate(path);
            }
        }

        return pathExpression;
    }
}

CompileContext.prototype.util = {
    isValidJavaScriptIdentifier: require('./util/isValidJavaScriptIdentifier')
};

module.exports = CompileContext;
});
$rmod.def("/marko@3.3.0/compiler/config", function(require, exports, module, __filename, __dirname) { var process=require("process"); var NODE_ENV = process.env.NODE_ENV;

module.exports = {
    /**
     * If true, then the compiler will check the disk to see if a previously compiled
     * template is the same age or newer than the source template. If so, the previously
     * compiled template will be loaded. Otherwise, the template will be recompiled
     * and saved to disk.
     *
     * If false, the template will always be recompiled. If `writeToDisk` is false
     * then this option will be ignored.
     */
    checkUpToDate: process.env.MARKO_CLEAN ? false : true,
    /**
     * If true (the default) then compiled templates will be written to disk. If false,
     * compiled templates will not be written to disk (i.e., no `.marko.js` file will
     * be generated)
     */
    writeToDisk: true,

    /**
     * If true, then the compiled template on disk will assumed to be up-to-date if it exists.
     */
    assumeUpToDate: process.env.MARKO_CLEAN != null || NODE_ENV == null ? false : (NODE_ENV !== 'development' && NODE_ENV !== 'dev'),

    /**
     * If true, whitespace will be preserved in templates. Defaults to false.
     * @type {Boolean}
     */
    preserveWhitespace: false
};
});
$rmod.main("/marko@3.3.0/compiler/taglib-lookup", "index");
$rmod.main("/marko@3.3.0/compiler/taglib-loader/Taglib", "index");
$rmod.def("/raptor-util@1.0.10/forEachEntry", function(require, exports, module, __filename, __dirname) { /**
 * Invokes a provided callback for each name/value pair
 * in a JavaScript object.
 *
 * <p>
 * <h2>Usage</h2>
 * <js>
 * raptor.forEachEntry(
 *     {
 *         firstName: "John",
 *         lastName: "Doe"
 *     },
 *     function(name, value) {
 *         console.log(name + '=' + value);
 *     },
 *     this);
 * )
 * // Output:
 * // firstName=John
 * // lastName=Doe
 * </js>
 * @param  {Object} o A JavaScript object that contains properties to iterate over
 * @param  {Function} fun The callback function for each property
 * @param  {Object} thisp The "this" object to use for the callback function
 * @return {void}
 */
module.exports = function(o, fun, thisp) {
    for (var k in o)
    {
        if (o.hasOwnProperty(k))
        {
            fun.call(thisp, k, o[k]);
        }
    }
};
});
$rmod.def("/marko@3.3.0/compiler/util/removeDashes", function(require, exports, module, __filename, __dirname) { module.exports = function removeDashes(str) {
    return str.replace(/-([a-z])/g, function (match, lower) {
        return lower.toUpperCase();
    });
};
});
$rmod.def("/marko@3.3.0/compiler/ast/CustomTag", function(require, exports, module, __filename, __dirname) { 'use strict';

var HtmlElement = require('./HtmlElement');
var removeDashes = require('../util/removeDashes');
var safeVarName = require('../util/safeVarName');
var ok = require('/$/assert'/*'assert'*/).ok;

function getNestedTagParentNode(nestedTagNode, parentTagName) {
    var currentNode = nestedTagNode.parentNode;
    while (currentNode) {
        if (currentNode.type === 'CustomTag' && currentNode.tagDef.name === parentTagName) {
            return currentNode;
        }

        currentNode = currentNode.parentNode;
    }
}

function getNestedVariables(elNode, tagDef, codegen) {
    var variableNames = [];
    tagDef.forEachVariable((nestedVar) => {
        var varName;
        if (nestedVar.nameFromAttribute) {
            var possibleNameAttributes = nestedVar.nameFromAttribute.split(/\s+or\s+|\s*,\s*/i);
            for (var i = 0, len = possibleNameAttributes.length; i < len; i++) {
                var attrName = possibleNameAttributes[i];
                var keep = false;
                if (attrName.endsWith('|keep')) {
                    keep = true;
                    attrName = attrName.slice(0, 0 - '|keep'.length);
                    possibleNameAttributes[i] = attrName;
                }
                varName = elNode.getAttributeValue(attrName);
                if (varName) {
                    if (varName.type !== 'Literal' || typeof varName.value !== 'string') {
                        codegen.addError('The value of the ' + attrName + ' is expected to be a string');
                        codegen.addError('Attribute ' + possibleNameAttributes.join(' or ') + ' is required');
                        varName = '_var';    // Let it continue with errors
                    }

                    varName = varName.value;

                    if (!keep) {
                        elNode.removeAttribute(attrName);
                    }
                    break;
                }
            }
            if (!varName) {
                codegen.addError('Attribute ' + possibleNameAttributes.join(' or ') + ' is required');
                varName = '_var';    // Let it continue with errors
            }
        } else {
            varName = nestedVar.name;
            if (!varName) {
                codegen.addError('Variable name is required');
                varName = '_var';    // Let it continue with errors
            }
        }
        variableNames.push(codegen.builder.identifier(varName));
    });

    if (elNode.additionalNestedVars.length) {
        elNode.additionalNestedVars.forEach((varName) => {
            variableNames.push(codegen.builder.identifier(varName));
        });
    }

    return variableNames;
}

function buildInputProps(el, context) {
    var tagDef = el.tagDef;
    var inputProps = {};

    function handleAttr(attrName, attrValue, attrDef) {
        if (!attrDef) {
            return; // Skip over attributes that are not supported
        }

        if (attrValue == null) {
            attrValue = context.builder.literalTrue();
        }

        var propName;
        var parentPropName;

        if (attrDef.dynamicAttribute) {
            // Dynamic attributes are allowed attributes
            // that are not declared (i.e. "*" attributes)
            //
            if (attrDef.removeDashes === true || attrDef.preserveName === false) {
                propName = removeDashes(attrName);
            } else {
                propName = attrName;
            }

            if (attrDef.targetProperty) {
                parentPropName = attrDef.targetProperty;
            }
        } else {
            // Attributes map to properties and we allow the taglib
            // author to control how an attribute name resolves
            // to a property name.
            if (attrDef.targetProperty) {
                propName = attrDef.targetProperty;
            } else if (attrDef.preserveName === true) {
                propName = attrName;
            } else {
                propName = removeDashes(attrName);
            }
        }

        if (attrDef.type === 'path') {
            attrValue = context.resolvePath(attrValue);
        } else if (attrDef.type === 'template') {
            attrValue = context.resolveTemplate(attrValue);
        }

        if (parentPropName) {
            let parent = inputProps[parentPropName] || (inputProps[parentPropName] = {});
            parent[propName] = attrValue;
        } else {
            inputProps[propName] = attrValue;
        }
    }

    // Add default values for any attributes from the tag definition. These added properties may get overridden
    // by get overridden from the attributes found on the actual HTML element.
    tagDef.forEachAttribute(function (attrDef) {
        if (attrDef.hasOwnProperty('defaultValue')) {
            handleAttr(
                attrDef.name,
                context.builder.literal(attrDef.defaultValue),
                attrDef);
        }
    });

    // Loop over the attributes found on the HTML element and add the corresponding properties
    // to the input object for the custom tag
    el.forEachAttribute((attr) => {
        var attrName = attr.name;
        var attrDef = attr.def || context.taglibLookup.getAttribute(el.tagName, attr.name);

        if (!attrDef) {
            context.addError(el, 'Unsupported attribute of "' + attrName + '" found on the <' + el.tagName + '> custom tag.');
            return; // Skip over attributes that are not supported
        }

        handleAttr(attrName, attr.value, attrDef);
    });

    // Imported variables are used to add input properties to a custom tag based on data/variables
    // found in the compiled template
    tagDef.forEachImportedVariable(function(importedVariable) {
        let propName = importedVariable.targetProperty;
        let propExpression = importedVariable.expression;

        inputProps[propName] = propExpression;
    });

    return inputProps;
}

function getNextNestedTagVarName(tagDef, context) {
    var key = 'customTag' + tagDef.name;

    var nestedTagVarInfo = context.data[key] || (context.data[key] = {
        next: 0
    });


    return safeVarName(tagDef.name) + (nestedTagVarInfo.next++);
}

class CustomTag extends HtmlElement {
    constructor(el, tagDef) {
        super(el);
        this.type = 'CustomTag';
        this.tagDef = tagDef;
        this.additionalNestedVars = [];
    }

    addNestedVariable(name) {
        ok(name, '"name" is required');
        this.additionalNestedVars.push(name);
    }

    generateCode(codegen) {
        if (this.type !== 'CustomTag') {
            throw new Error(this.type);
        }
        var builder = codegen.builder;
        var context = codegen.context;

        var tagDef = this.tagDef;

        var isNestedTag = tagDef.isNestedTag === true;
        var hasNestedTags = tagDef.hasNestedTags();
        var parentTagName;
        var isRepeated;
        var targetProperty;

        if (isNestedTag) {
            parentTagName = tagDef.parentTagName;
            isRepeated = tagDef.isRepeated === true;
            targetProperty = builder.literal(tagDef.targetProperty);
        }

        var nestedTagVar;

        if (hasNestedTags) {
            nestedTagVar = this.data.nestedTagVar = builder.identifier(getNextNestedTagVarName(tagDef, context));
        }

        let parentTagVar;

        if (isNestedTag) {
            let parentTagNode = getNestedTagParentNode(this, parentTagName);
            if (!parentTagNode) {
                codegen.addError('Invalid usage of the <' + this.tagName + '> nested tag. Tag not nested within a <' + parentTagName + '> tag.');
                return;
            }
            parentTagVar = parentTagNode.data.nestedTagVar;
        }

        var nestedVariableNames = getNestedVariables(this, tagDef, codegen);

        var inputProps = buildInputProps(this, context);
        var renderBodyFunction;

        if (this.body && this.body.length) {

            if (tagDef.bodyFunction) {
                let bodyFunction = tagDef.bodyFunction;
                let bodyFunctionName = bodyFunction.name;
                let bodyFunctionParams = bodyFunction.params.map(function(param) {
                    return builder.identifier(param);
                });

                inputProps[bodyFunctionName] = builder.functionDeclaration(bodyFunctionName, bodyFunctionParams, this.body);
            } else {
                renderBodyFunction = context.builder.renderBodyFunction(this.body);
                if (nestedTagVar) {
                    renderBodyFunction.params.push(nestedTagVar);
                } else {
                    if (nestedVariableNames && nestedVariableNames.length) {
                        renderBodyFunction.params = renderBodyFunction.params.concat(nestedVariableNames);
                    }
                }
            }
        }

        // Store the renderBody function with the input, but only if the body does not have
        // nested tags
        if (renderBodyFunction && !hasNestedTags) {
            inputProps.renderBody = renderBodyFunction;
        }

        inputProps = builder.literal(inputProps);

        var argument = this.argument;

        if (argument) {
            argument = builder.parseExpression(argument);

            if (Object.keys(inputProps.value).length === 0) {
                inputProps = argument;
            } else {
                var mergeVar = codegen.addStaticVar('__merge', '__helpers.m');
                inputProps = builder.functionCall(mergeVar, [
                    inputProps, // Input props from the attributes take precedence
                    argument
                ]);
            }
        }

        var rendererPath = tagDef.renderer;
        var rendererRequirePath;
        var requireRendererFunctionCall;

        if (rendererPath) {
            rendererRequirePath = context.getRequirePath(rendererPath);
            requireRendererFunctionCall = builder.require(JSON.stringify(rendererRequirePath));
        } else {
            requireRendererFunctionCall = builder.literal(null);
        }

        if (tagDef.template) {
            let templateRequirePath = context.getRequirePath(tagDef.template);
            let templateVar = context.importTemplate(templateRequirePath);
            let renderMethod = builder.memberExpression(templateVar, builder.identifier('render'));
            let renderArgs = [ inputProps, 'out' ];
            let renderFunctionCall = builder.functionCall(renderMethod, renderArgs);
            return renderFunctionCall;
        } else {
            var loadTagVar = codegen.addStaticVar('__loadTag', '__helpers.t');

            var loadTagArgs = [
                requireRendererFunctionCall // The first param is the renderer
            ];

            if (isNestedTag || hasNestedTags) {
                if (isNestedTag) {
                    loadTagArgs.push(targetProperty); // targetProperty
                    loadTagArgs.push(builder.literal(isRepeated ? 1 : 0)); // isRepeated
                } else {
                    loadTagArgs.push(builder.literal(0)); // targetProperty
                    loadTagArgs.push(builder.literal(0)); // isRepeated
                }

                if (hasNestedTags) {
                    loadTagArgs.push(builder.literal(1));
                }
            }

            var loadTag = builder.functionCall(loadTagVar, loadTagArgs);

            let tagVar = codegen.addStaticVar(tagDef.name, loadTag);
            let tagArgs = [inputProps, 'out' ];

            if (isNestedTag || hasNestedTags) {
                tagArgs.push(isNestedTag ? parentTagVar : builder.literal(0));

                if (renderBodyFunction && hasNestedTags) {
                    tagArgs.push(renderBodyFunction);
                }
            }
            let tagFunctionCall = builder.functionCall(tagVar, tagArgs);
            return tagFunctionCall;
        }
    }
}

module.exports = CustomTag;
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/Taglib/Tag", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
'use strict';
var forEachEntry = require('/$/raptor-util/forEachEntry'/*'raptor-util/forEachEntry'*/);
var ok = require('/$/assert'/*'assert'*/).ok;
var CustomTag = require('../../ast/CustomTag');

function inheritProps(sub, sup) {
    forEachEntry(sup, function (k, v) {
        if (!sub[k]) {
            sub[k] = v;
        }
    });
}

function createCustomTagNodeFactory(tagDef) {
    return function nodeFactory(el) {
        return new CustomTag(el, tagDef);
    };
}

class Tag{
    constructor(taglib) {
        this.name = undefined;
        this.taglibId = taglib ? taglib.id : null;
        this.renderer = null;
        this.codeGeneratorModulePath = null;
        this.nodeFactoryPath = null;
        this.template = null;
        this.attributes = {};
        this.transformers = {};
        this.nestedVariables = null;
        this.importedVariables = null;
        this.patternAttributes = [];
        this.bodyFunction = null;
        this.nestedTags = null;
        this.isRepeated = null;
        this.isNestedTag = false;
        this.parentTagName = null;
        this.openTagOnly = null;
        this.body = null;
        this.type = null; // Only applicable for nested tags
        this._nodeFactory = undefined;
    }

    inheritFrom(superTag) {
        var subTag = this;
        /*
         * Have the sub tag inherit any properties from the super tag that are not in the sub tag
         */
        forEachEntry(superTag, function (k, v) {
            if (subTag[k] === undefined) {
                subTag[k] = v;
            }
        });
        [
            'attributes',
            'transformers',
            'nestedVariables',
            'importedVariables',
            'bodyFunction'
        ].forEach(function (propName) {
            inheritProps(subTag[propName], superTag[propName]);
        });
        subTag.patternAttributes = superTag.patternAttributes.concat(subTag.patternAttributes);
    }

    forEachVariable(callback, thisObj) {
        if (!this.nestedVariables) {
            return;
        }

        this.nestedVariables.vars.forEach(callback, thisObj);
    }

    forEachImportedVariable(callback, thisObj) {
        if (!this.importedVariables) {
            return;
        }

        forEachEntry(this.importedVariables, function (key, importedVariable) {
            callback.call(thisObj, importedVariable);
        });
    }

    forEachTransformer(callback, thisObj) {
        forEachEntry(this.transformers, function (key, transformer) {
            callback.call(thisObj, transformer);
        });
    }
    hasTransformers() {
        /*jshint unused:false */
        for (var k in this.transformers) {
            if (this.transformers.hasOwnProperty(k)) {
                return true;
            }

        }
        return false;
    }
    addAttribute(attr) {
        if (attr.pattern) {
            this.patternAttributes.push(attr);
        } else {
            if (attr.name === '*') {
                attr.dynamicAttribute = true;

                if (attr.targetProperty === null || attr.targetProperty === '') {
                    attr.targetProperty = null;

                }
                else if (!attr.targetProperty) {
                    attr.targetProperty = '*';
                }
            }

            this.attributes[attr.name] = attr;
        }
    }
    toString() {
        return '[Tag: <' + this.name + '@' + this.taglibId + '>]';
    }
    forEachAttribute(callback, thisObj) {
        for (var attrName in this.attributes) {
            if (this.attributes.hasOwnProperty(attrName)) {
                callback.call(thisObj, this.attributes[attrName]);
            }
        }
    }
    addNestedVariable(nestedVariable) {
        if (!this.nestedVariables) {
            this.nestedVariables = {
                __noMerge: true,
                vars: []
            };
        }

        this.nestedVariables.vars.push(nestedVariable);
    }
    addImportedVariable(importedVariable) {
        if (!this.importedVariables) {
            this.importedVariables = {};
        }
        var key = importedVariable.targetProperty;
        this.importedVariables[key] = importedVariable;
    }
    addTransformer(transformer) {
        var key = transformer.path;
        transformer.taglibId = this.taglibId;
        this.transformers[key] = transformer;
    }
    setBodyFunction(name, params) {
        this.bodyFunction = {
            __noMerge: true,
            name: name,
            params: params
        };
    }
    setBodyProperty(propertyName) {
        this.bodyProperty = propertyName;
    }
    addNestedTag(nestedTag) {
        ok(nestedTag.name, '"nestedTag.name" is required');

        if (!this.nestedTags) {
            this.nestedTags = {};
        }

        nestedTag.isNestedTag = true;

        if (!nestedTag.targetProperty) {
            nestedTag.targetProperty = nestedTag.name;
        }

        this.nestedTags[nestedTag.name] = nestedTag;
    }
    forEachNestedTag(callback, thisObj) {
        if (!this.nestedTags) {
            return;
        }

        forEachEntry(this.nestedTags, function (key, nestedTag) {
            callback.call(thisObj, nestedTag);
        });
    }
    hasNestedTags() {
        return this.nestedTags != null;
    }
    getNodeFactory() {
        var nodeFactory = this._nodeFactory;
        if (nodeFactory !== undefined) {
            return nodeFactory;
        }

        let codeGeneratorModulePath = this.codeGeneratorModulePath;

        if (this.codeGeneratorModulePath) {
            var loadedCodeGenerator = require(this.codeGeneratorModulePath);
            nodeFactory = function(elNode) {
                elNode.setType(codeGeneratorModulePath);
                elNode.setCodeGenerator(loadedCodeGenerator);
                return elNode;
            };
        } else if (this.nodeFactoryPath) {
            nodeFactory = require(this.nodeFactoryPath);
            if (typeof nodeFactory !== 'function') {
                throw new Error('Invalid node factory exported by module at path "' + this.nodeFactoryPath + '"');
            }
        } else if (this.renderer || this.template || this.isNestedTag) {
            nodeFactory = createCustomTagNodeFactory(this);
        } else {
            return null;
        }

        return (this._nodeFactory = nodeFactory);
    }

    toJSON() {
        return this;
    }
}

module.exports = Tag;
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/Taglib/Attribute", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

'use strict';

class Attribute {
    constructor(name) {
        this.name = name;
        this.type = null;
        this.required = false;
        this.type = 'string';
        this.allowExpressions = true;
        this.setFlag = null;
        this.pattern = null;
    }
}

module.exports = Attribute;
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/Taglib/Property", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
'use strict';

class Property {
    constructor() {
        this.name = null;
        this.type = 'string';
        this.value = undefined;
    }
}

module.exports = Property;
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/Taglib/NestedVariable", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
'use strict';

class NestedVariable {
    constructor() {
        this.name = null;
    }
}

module.exports = NestedVariable;
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/Taglib/ImportedVariable", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

'use strict';

class ImportedVariable {
    constructor() {
        this.targetProperty = null;
        this.expression = null;
    }
}

module.exports = ImportedVariable;
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/Taglib/Transformer", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
'use strict';var process=require("process"); 
var nextTransformerId = 0;

class Transformer {
    constructor() {
        this.id = nextTransformerId++;
        this.name = null;
        this.tag = null;
        this.path = null;
        this.priority = null;
        this._func = null;
        this.properties = {};
    }

    getFunc() {
        if (!this.path) {
            throw new Error('Transformer path not defined for tag transformer (tag=' + this.tag + ')');
        }

        if (!this._func) {
            var transformer = require(this.path);

            if (typeof transformer === 'function') {
                if (transformer.prototype.process) {
                    var Clazz = transformer;
                    var instance = new Clazz();
                    instance.id = this.id;
                    this._func = instance.process.bind(instance);
                } else {
                    this._func = transformer;
                }
            } else {
                this._func = transformer.process || transformer.transform;
            }
        }
        return this._func;
    }
    toString() {
        return '[Taglib.Transformer: ' + this.path + ']';
    }
}

module.exports = Transformer;
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/Taglib/Taglib", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var forEachEntry = require('/$/raptor-util/forEachEntry'/*'raptor-util/forEachEntry'*/);
var ok = require('/$/assert'/*'assert'*/).ok;
var taglibLoader;

function handleImport(taglib, importedTaglib) {
    var importsLookup = taglib.importsLookup || (taglib.importsLookup = {});
    if (importsLookup.hasOwnProperty(importedTaglib.path)) {
        return;
    }

    importsLookup[importedTaglib.path] = importedTaglib;

    if (!taglib.imports) {
        taglib.imports = [];
    }

    taglib.imports.push(importedTaglib);
    taglib.addInputFile(importedTaglib.path);

    if (importedTaglib.imports) {
        importedTaglib.imports.forEach(function(nestedImportedTaglib) {
            handleImport(taglib, nestedImportedTaglib);
        });
    }
}



class Taglib {
    constructor(path) {
        ok(path, '"path" expected');
        this.path = this.id = path;
        this.dirname = null;
        this.tags = {};
        this.textTransformers = [];
        this.attributes = {};
        this.patternAttributes = [];
        this.inputFilesLookup = {};
        this.imports = null;
        this.importsLookup = null;
    }

    addInputFile(path) {
        this.inputFilesLookup[path] = true;
    }

    getInputFiles() {
        return Object.keys(this.inputFilesLookup);
    }

    addAttribute (attribute) {
        if (attribute.pattern) {
            this.patternAttributes.push(attribute);
        } else if (attribute.name) {
            this.attributes[attribute.name] = attribute;
        } else {
            throw new Error('Invalid attribute: ' + require('/$/util'/*'util'*/).inspect(attribute));
        }
    }
    getAttribute (name) {
        var attribute = this.attributes[name];
        if (!attribute) {
            for (var i = 0, len = this.patternAttributes.length; i < len; i++) {
                var patternAttribute = this.patternAttributes[i];
                if (patternAttribute.pattern.test(name)) {
                    attribute = patternAttribute;
                }
            }
        }
        return attribute;
    }
    addTag (tag) {
        ok(arguments.length === 1, 'Invalid args');
        if (!tag.name) {
            throw new Error('"tag.name" is required: ' + JSON.stringify(tag));
        }
        this.tags[tag.name] = tag;
        tag.taglibId = this.id || this.path;
    }
    addTextTransformer (transformer) {
        this.textTransformers.push(transformer);
    }
    forEachTag (callback, thisObj) {
        forEachEntry(this.tags, function (key, tag) {
            callback.call(thisObj, tag);
        }, this);
    }

    addImport(path) {
        var importedTaglib = taglibLoader.load(path);
        handleImport(this, importedTaglib);
    }

    toJSON() {
        return {
            path: this.path,
            tags: this.tags,
            textTransformers: this.textTransformers,
            attributes: this.attributes,
            patternAttributes: this.patternAttributes,
            imports: this.imports
        };
    }
}

Taglib.Tag = require('./Tag');
Taglib.Attribute = require('./Attribute');
Taglib.Property = require('./Property');
Taglib.NestedVariable = require('./NestedVariable');
Taglib.ImportedVariable = require('./ImportedVariable');
Taglib.Transformer = require('./Transformer');

module.exports = Taglib;

taglibLoader = require('../');
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/Taglib/index", function(require, exports, module, __filename, __dirname) { module.exports = require('./Taglib');
});
$rmod.def("/marko@3.3.0/compiler/taglib-lookup/TaglibLookup", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
'use strict';

var ok = require('/$/assert'/*'assert'*/).ok;
var Taglib = require('../taglib-loader/Taglib');
var extend = require('/$/raptor-util/extend'/*'raptor-util/extend'*/);
var Text = require('../ast/Text');

function transformerComparator(a, b) {
    a = a.priority;
    b = b.priority;

    if (a == null) {
        a = Number.MAX_VALUE;
    }

    if (b == null) {
        b = Number.MAX_VALUE;
    }

    return a - b;
}

function TAG_COMPARATOR(a, b) {
    a = a.name;
    b = b.name;
    return a.localeCompare(b);
}

function merge(target, source) {
    for (var k in source) {
        if (source.hasOwnProperty(k)) {
            if (target[k] && typeof target[k] === 'object' &&
                source[k] && typeof source[k] === 'object') {

                if (source.__noMerge) {
                    // Don't merge objects that are explicitly marked as "do not merge"
                    continue;
                }

                if (Array.isArray(target[k]) || Array.isArray(source[k])) {

                    var targetArray = target[k];
                    var sourceArray = source[k];


                    if (!Array.isArray(targetArray)) {
                        targetArray = [targetArray];
                    }

                    if (!Array.isArray(sourceArray)) {
                        sourceArray = [sourceArray];
                    }

                    target[k] = [].concat(targetArray).concat(sourceArray);
                } else {
                    var Ctor = target[k].constructor;
                    var newTarget = new Ctor();
                    merge(newTarget, target[k]);
                    merge(newTarget, source[k]);
                    target[k] = newTarget;
                }

            } else {
                target[k] = source[k];
            }
        }
    }

    return target;
}

/**
 * A taglib lookup merges in multiple taglibs so there is a single and fast lookup
 * for custom tags and custom attributes.
 */
class TaglibLookup {
    constructor() {
        this.merged = {};
        this.taglibsById = {};
        this._inputFiles = null;

        this._sortedTags = undefined;
    }

    hasTaglib(taglib) {
        return this.taglibsById.hasOwnProperty(taglib.id);
    }

    _mergeNestedTags(taglib) {
        var Tag = Taglib.Tag;
        // Loop over all of the nested tags and register a new custom tag
        // with the fully qualified name

        var merged = this.merged;

        function handleNestedTags(tag, parentTagName) {
            tag.forEachNestedTag(function(nestedTag) {
                var fullyQualifiedName = parentTagName + ':' + nestedTag.name;
                // Create a clone of the nested tag since we need to add some new
                // properties
                var clonedNestedTag = new Tag();
                extend(clonedNestedTag, nestedTag);
                // Record the fully qualified name of the parent tag that this
                // custom tag is associated with.
                clonedNestedTag.parentTagName = parentTagName;
                clonedNestedTag.name = fullyQualifiedName;
                merged.tags[fullyQualifiedName] = clonedNestedTag;
                handleNestedTags(clonedNestedTag, fullyQualifiedName);
            });
        }

        taglib.forEachTag(function(tag) {
            handleNestedTags(tag, tag.name);
        });
    }

    addTaglib(taglib) {
        ok(taglib, '"taglib" is required');
        ok(taglib.id, '"taglib.id" expected');

        if (this.taglibsById.hasOwnProperty(taglib.id)) {
            return;
        }

        this._sortedTags = undefined;

        this.taglibsById[taglib.id] = taglib;

        merge(this.merged, {
            tags: taglib.tags,
            textTransformers: taglib.textTransformers,
            attributes: taglib.attributes,
            patternAttributes: taglib.patternAttributes
        });

        this._mergeNestedTags(taglib);
    }

    getTagsSorted() {
        var sortedTags = this._sortedTags;

        if (sortedTags === undefined) {
            sortedTags = this._sortedTags = [];
            this.forEachTag((tag) => {
                sortedTags.push(tag);
            });
            sortedTags.sort(TAG_COMPARATOR);
        }

        return sortedTags;
    }

    forEachTag(callback) {
        var tags = this.merged.tags;
        if (tags) {
            for (var tagName in tags) {
                if (tags.hasOwnProperty(tagName)) {
                    var tag = tags[tagName];
                    var result = callback(tag);
                    if (result === false) {
                        break;
                    }
                }
            }
        }
    }

    forEachAttribute(tagName, callback) {
        var tags = this.merged.tags;
        if (!tags) {
            return;
        }

        function findAttributesForTagName(tagName) {
            var tag = tags[tagName];
            if (!tag) {
                return;
            }

            var attributes = tag.attributes;
            if (!attributes) {
                return;
            }

            for (var attrName in attributes) {
                if (attributes.hasOwnProperty(attrName)) {
                    callback(attributes[attrName], tag);
                }
            }

            if (tag.patternAttributes) {
                tag.patternAttributes.forEach(callback);
            }
        }

        findAttributesForTagName(tagName); // Look for an exact match at the tag level
        findAttributesForTagName('*'); // Including attributes that apply to all tags
    }

    getTag(element) {
        if (typeof element === 'string') {
            element = {
                tagName: element
            };
        }
        var tags = this.merged.tags;
        if (!tags) {
            return;
        }

        var tagName = element.tagName;
        return tags[tagName];
    }

    getAttribute(element, attr) {
        if (typeof element === 'string') {
            element = {
                tagName: element
            };
        }

        if (typeof attr === 'string') {
            attr = {
                name: attr
            };
        }

        var tags = this.merged.tags;
        if (!tags) {
            return;
        }

        var tagName = element.tagName;
        var attrName = attr.name;

        function findAttributeForTag(tag, attributes, attrName) {
            // try by exact match first
            var attribute = attributes[attrName];
            if (attribute === undefined && attrName !== '*') {
                if (tag.patternAttributes) {
                    // try searching by pattern
                    for (var i = 0, len = tag.patternAttributes.length; i < len; i++) {
                        var patternAttribute = tag.patternAttributes[i];
                        if (patternAttribute.pattern.test(attrName)) {
                            attribute = patternAttribute;
                            break;
                        }
                    }
                }
            }

            return attribute;
        }

        var globalAttributes = this.merged.attributes;

        function tryAttribute(tagName, attrName) {
            var tag = tags[tagName];
            if (!tag) {
                return undefined;
            }

            return findAttributeForTag(tag, tag.attributes, attrName) ||
                   findAttributeForTag(tag, globalAttributes, attrName);
        }

        var attrDef = tryAttribute(tagName, attrName) || // Look for an exact match at the tag level
            tryAttribute('*', attrName) || // If not there, see if there is a exact match on the attribute name for attributes that apply to all tags
            tryAttribute(tagName, '*'); // Otherwise, see if there is a splat attribute for the tag

        return attrDef;
    }

    forEachNodeTransformer(node, callback, thisObj) {
        /*
         * Based on the type of node we have to choose how to transform it
         */
        if (node.tagName) {
            this.forEachTagTransformer(node, callback, thisObj);
        } else if (node instanceof Text) {
            this.forEachTextTransformer(callback, thisObj);
        }
    }

    forEachTagTransformer(element, callback, thisObj) {
        if (typeof element === 'string') {
            element = {
                tagName: element
            };
        }

        var tagName = element.tagName;
        /*
         * If the node is an element node then we need to find all matching
         * transformers based on the URI and the local name of the element.
         */

        var transformers = [];

        function addTransformer(transformer) {
            if (!transformer || !transformer.getFunc) {
                throw new Error('Invalid transformer');
            }

            transformers.push(transformer);
        }

        /*
         * Handle all of the transformers for all possible matching transformers.
         *
         * Start with the least specific and end with the most specific.
         */

        if (this.merged.tags) {
            if (this.merged.tags[tagName]) {
                this.merged.tags[tagName].forEachTransformer(addTransformer);
            }

            if (this.merged.tags['*']) {
                this.merged.tags['*'].forEachTransformer(addTransformer);
            }
        }

        transformers.sort(transformerComparator);

        transformers.forEach(callback, thisObj);
    }

    forEachTextTransformer(callback, thisObj) {
        if (this.merged.textTransformers) {
            this.merged.textTransformers.sort(transformerComparator);
            this.merged.textTransformers.forEach(callback, thisObj);
        }
    }

    getInputFiles() {
        if (!this._inputFiles) {
            var inputFilesSet = {};

            for (var taglibId in this.taglibsById) {
                if (this.taglibsById.hasOwnProperty(taglibId)) {

                    var taglibInputFiles = this.taglibsById[taglibId].getInputFiles();
                    var len = taglibInputFiles.length;
                    if (len) {
                        for (var i=0; i<len; i++) {
                            inputFilesSet[taglibInputFiles[i]] = true;
                        }
                    }
                }
            }

            this._inputFiles = Object.keys(inputFilesSet);
        }

        return this._inputFiles;
    }

    toString() {
        return 'lookup: ' + this.getInputFiles().join(', ');
    }
}

module.exports = TaglibLookup;
});
$rmod.def("/marko@3.3.0/compiler/taglib-lookup/index", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
'use strict';
exports.registerTaglib = registerTaglib;
exports.buildLookup = buildLookup;
exports.clearCache = clearCache;

var taglibLoader = require('../taglib-loader');
var taglibFinder = require('../taglib-finder');
var TaglibLookup = require('./TaglibLookup');

exports.registeredTaglibs = [];

var lookupCache = {};

function handleImports(lookup, taglib) {
	if (taglib.imports) {
		for (var i=0; i<taglib.imports.length; i++) {
			var importedTaglib = taglib.imports[i];

			if (!lookup.hasTaglib(importedTaglib)) {
				lookup.addTaglib(importedTaglib);
			}
		}
	}
}

function buildLookup(dirname) {
	var taglibs = taglibFinder.find(dirname, exports.registeredTaglibs);

	var lookupCacheKey = taglibs
		.map(function(taglib) {
			return taglib.id;
		})
		.join(',');

	var lookup = lookupCache[lookupCacheKey];
	if (lookup === undefined) {
		lookup = new TaglibLookup();
		// The taglibs "closer" to the template will be earlier in the list
		// and the taglibs "farther" from the template will be later. We
		// want closer taglibs to take precedence (especially when de-duping)
		// so we loop from beginning to end. We used to loop from the end
		// to the beginning, but that appears to have been a mistake.
        for (var i=0; i<taglibs.length; i++) {
			var taglib = taglibs[i];
			lookup.addTaglib(taglib);
			handleImports(lookup, taglib);
		}

		lookupCache[lookupCacheKey] = lookup;
	}

	return lookup;
}

function registerTaglib(taglib) {
    if (typeof taglib === 'string') {
        taglib = taglibLoader.load(taglib);
    }

    exports.registeredTaglibs.push(taglib);
}

function clearCache() {
	lookupCache = {};
}
});
$rmod.main("/marko@3.3.0/compiler/taglib-loader", "index");
$rmod.def("/marko@3.3.0/compiler/taglib-loader/handleAttributes", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

var ok = require('/$/assert'/*'assert'*/).ok;
var forEachEntry = require('/$/raptor-util/forEachEntry'/*'raptor-util/forEachEntry'*/);
var loader = require('./loader');

module.exports = function handleAttributes(value, parent, path) {
    ok(parent);

    forEachEntry(value, function(attrName, attrProps) {
        var attr = loader.attributeLoader.loadAttribute(
            attrName,
            attrProps,
            '"' + attrName + '" attribute as part of ' + path);

        parent.addAttribute(attr);
    });
};
});
$rmod.remap("/marko@3.3.0/compiler/taglib-loader/scanTagsDir", "scanTagsDir-browser");
$rmod.def("/marko@3.3.0/compiler/taglib-loader/scanTagsDir-browser", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
* 
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
* 
*    http://www.apache.org/licenses/LICENSE-2.0
* 
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

module.exports = function scanTagsDir() {
    // no-op in the browser
};
});
$rmod.remap("/marko@3.3.0/compiler/util/resolve", "resolve-browser");
$rmod.def("/marko@3.3.0/compiler/util/resolve-browser", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
* 
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
* 
*    http://www.apache.org/licenses/LICENSE-2.0
* 
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

var nodePath = require('path-browserify'/*'path'*/);

module.exports = function(target, from) {
    return nodePath.join(from, target);
};
});
$rmod.main("/property-handlers@1.0.1", "lib/index");
$rmod.dep("", "property-handlers", "1.0.1");
$rmod.def("/property-handlers@1.0.1/lib/index", function(require, exports, module, __filename, __dirname) { function removeDashes(str) {
    return str.replace(/-([a-z])/g, function (match, lower) {
        return lower.toUpperCase();
    });
}

module.exports = function invokeHandlers(config, handlers, options) {
    var path;

    if (options != null) {
        if (typeof options === 'string') {
            path = options;
        } else {
            path = options.path;
        }
    }

    function error(message, cause) {
        if (cause) {
            if (cause.__propertyHandlers) {
                throw cause;
            }

            message += '. Cause: ' + (cause.stack || cause);
        }

        if (path) {
            message = 'Error while handling properties for ' + path + ': ' + message;
        }

        var e = new Error(message);
        e.__propertyHandlers = true;
        throw e;
    }

    if (!config) {
        error('"config" argument is required');
    }

    if (typeof config !== 'object') {
        error('object expected');
    }

    for (var k in config) {
        if (config.hasOwnProperty(k)) {
            var value = config[k];
            var keyNoDashes = removeDashes(k);
            var handler = handlers[keyNoDashes];
            var isDefaultHandler = false;

            if (!handler) {
                handler = handlers['*'];
                isDefaultHandler = true;
            }

            if (!handler) {
                error('Invalid option of "' + keyNoDashes + '". Allowed: ' + Object.keys(handlers).join(', '));
            }

            try {
                if (isDefaultHandler) {
                    if (handler.call(handlers, k, value) === false) {
                        error('Invalid option: ' + k);
                    }
                } else {
                    handler.call(handlers, value);
                }
            } catch(e) {
                error('Error while applying option of "' + k + '"', e);
            }
        }
    }

    if (handlers._end) {
        try {
            handlers._end();
        }
        catch(e) {
            error('Error after applying properties', e);
        }
    }
};
});
$rmod.remap("/marko@3.3.0/compiler/taglib-loader/taglib-reader", "taglib-reader-browser");
$rmod.def("/marko@3.3.0/compiler/taglib-loader/taglib-reader-browser", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
* 
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
* 
*    http://www.apache.org/licenses/LICENSE-2.0
* 
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

exports.readTaglib = function (path) {
    var taglibProps;

    try {
        taglibProps = require(path);
    } catch(e) {
        throw new Error('Unable to parse taglib JSON at path "' + path + '". Exception: ' + e);
    }

    return taglibProps;
};
});
$rmod.main("/try-require@1.2.1", "index");
$rmod.dep("", "try-require", "1.2.1");
$rmod.def("/try-require@1.2.1/index", function(require, exports, module, __filename, __dirname) { 'use strict';

var lastError = null;

var tryRequire = function tryRequire( id, req ) {
    var path;
    var _req = req || require;

    try {
        path = _req.resolve( id );

        lastError = null;
    } catch ( e ) {
        lastError = e;
    }

    if ( path ) {
        return _req( path );
    }

    return undefined;
};

var resolve = function tryRequireResolve( id, req ) {
    var path;
    var _req = req || require;

    try {
        path = _req.resolve( id );

        lastError = null;
    } catch ( e ) {
        lastError = e;
    }

    return path;
};

tryRequire.resolve = resolve;
tryRequire.lastError = function() {
    return lastError;
};

module.exports = tryRequire;

});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/loader-taglib", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

var ok = require('/$/assert'/*'assert'*/).ok;
var nodePath = require('path-browserify'/*'path'*/);
var handleAttributes = require('./handleAttributes');
var scanTagsDir = require('./scanTagsDir');
var resolve = require('../util/resolve'); // NOTE: different implementation for browser
var propertyHandlers = require('/$/property-handlers'/*'property-handlers'*/);
var Taglib = require('./Taglib');
var taglibReader = require('./taglib-reader');
var loader = require('./loader');
var tryRequire = require('/$/try-require'/*'try-require'*/);
var resolveFrom = tryRequire('resolve-from', require);

function exists(path) {
    try {
        require.resolve(path);
        return true;
    } catch(e) {
        return false;
    }
}

function handleTag(taglibHandlers, tagName, path) {
    var taglib = taglibHandlers.taglib;
    var dirname = taglibHandlers.dirname;

    ok(path, 'Invalid tag definition for "' + tagName + '"');

    var tagObject;

    var tagDirname;

    if (typeof path === 'string') {
        path = nodePath.resolve(dirname, path);
        taglib.addInputFile(path);

        tagDirname = nodePath.dirname(path);
        if (!exists(path)) {
            throw new Error('Tag at path "' + path + '" does not exist. Taglib: ' + taglib.path);
        }

        try {
            tagObject = require(path);
        } catch(e) {
            throw new Error('Unable to parse tag JSON for tag at path "' + path + '"');
        }
    } else {
        tagDirname = dirname; // Tag is in the same taglib file
        tagObject = path;
        path = '<' + tagName + '> tag in ' + taglib.path;
    }

    var tag = loader.tagLoader.loadTag(tagObject, path, taglib, tagDirname);
    if (tag.name === undefined) {
        tag.name = tagName;
    }
    taglib.addTag(tag);
}

/**
 * We load a taglib definion using this class. Properties in the taglib
 * definition (which is just a JavaScript object with properties)
 * are mapped to handler methods in an instance of this type.
 *
 *
 * @param {Taglib} taglib The initially empty Taglib instance that we will populate
 * @param {String} path The file system path to the taglib that we are loading
 */
function TaglibHandlers(taglib, path) {
    ok(taglib);
    ok(path);

    this.taglib = taglib;
    this.path = path;
    this.dirname = nodePath.dirname(path);
}

TaglibHandlers.prototype = {
    attributes: function(value) {
        // The value of the "attributes" property will be an object
        // where each property maps to an attribute definition. Since these
        // attributes are on the taglib they will be "global" attribute
        // defintions.
        //
        // The property key will be the attribute name and the property value
        // will be the attribute definition. Example:
        // {
        //     "attributes": {
        //         "foo": "string",
        //         "bar": "expression"
        //     }
        // }
        var taglib = this.taglib;
        var path = this.path;

        handleAttributes(value, taglib, path);
    },
    tags: function(tags) {
        // The value of the "tags" property will be an object
        // where each property maps to an attribute definition. The property
        // key will be the tag name and the property value
        // will be the tag definition. Example:
        // {
        //     "tags": {
        //         "foo": {
        //             "attributes": { ... }
        //         },
        //         "bar": {
        //             "attributes": { ... }
        //         },
        //     }
        // }

        for (var tagName in tags) {
            if (tags.hasOwnProperty(tagName)) {
                handleTag(this, tagName, tags[tagName]);
            }
        }
    },
    tagsDir: function(dir) {
        // The "tags-dir" property is used to supporting scanning
        // of a directory to discover custom tags. Scanning a directory
        // is a much simpler way for a developer to create custom tags.
        // Only one tag is allowed per directory and the directory name
        // corresponds to the tag name. We only search for directories
        // one level deep.
        var taglib = this.taglib;
        var path = this.path;
        var dirname = this.dirname;

        if (Array.isArray(dir)) {
            for (var i = 0; i < dir.length; i++) {
                scanTagsDir(path, dirname, dir[i], taglib);
            }
        } else {
            scanTagsDir(path, dirname, dir, taglib);
        }
    },

    taglibImports: function(imports) {
        if (!resolveFrom) {
            return;
        }
        // The "taglib-imports" property allows another taglib to be imported
        // into this taglib so that the tags defined in the imported taglib
        // will be part of this taglib.
        //
        // NOTE: If a taglib import refers to a package.json file then we read
        //       the package.json file and automatically import *all* of the
        //       taglibs from the installed modules found in the "dependencies"
        //       section
        var taglib = this.taglib;
        var dirname = this.dirname;
        var importPath;

        if (imports && Array.isArray(imports)) {
            for (var i=0; i<imports.length; i++) {
                var curImport = imports[i];
                if (typeof curImport === 'string') {
                    var basename = nodePath.basename(curImport);
                    if (basename === 'package.json') {
                        var packagePath = resolve(curImport, dirname);
                        var pkg = require(packagePath);
                        var dependencies = pkg.dependencies;
                        if (dependencies) {
                            var dependencyNames = Object.keys(dependencies);
                            for (var j=0; j<dependencyNames.length; j++) {
                                var dependencyName = dependencyNames[j];

                                try {
                                    importPath = resolveFrom(dirname, dependencyName + '/marko.json');
                                } catch(e) {}

                                if (importPath) {
                                    taglib.addImport(importPath);
                                }
                            }
                        }
                    } else {
                        importPath = resolveFrom(dirname, curImport);
                        taglib.addImport(importPath);
                    }
                }
            }
        }
    },

    textTransformer: function(value) {
        // Marko allows a "text-transformer" to be registered. The provided
        // text transformer will be called for any static text found in a template.
        var taglib = this.taglib;
        var path = this.path;
        var dirname = this.dirname;

        var transformer = new Taglib.Transformer();

        if (typeof value === 'string') {
            value = {
                path: value
            };
        }

        propertyHandlers(value, {
            path: function(value) {
                var path = resolve(value, dirname);
                transformer.path = path;
            }

        }, 'text-transformer in ' + path);

        ok(transformer.path, '"path" is required for transformer');

        taglib.addInputFile(transformer.path);

        taglib.addTextTransformer(transformer);
    },

    /**
     * Allows an ID to be explicitly assigned to a taglib.
     * The taglib ID is used to prevent the same taglib  (even if different versions)
     * from being loaded multiple times.
     *
     * NOTE: Introduced as part of fix for #73
     *
     * @param  {String} value The taglib ID
     */
    taglibId: function(value) {
        var taglib = this.taglib;
        taglib.id = value;
    }
};

exports.loadTaglib = function(path, taglib) {
    var taglibProps = taglibReader.readTaglib(path);

    taglib = taglib || new Taglib(path);
    taglib.addInputFile(path);

    var taglibHandlers = new TaglibHandlers(taglib, path);

    // We register a wildcard handler to handle "@my-attr" and "<my-tag>"
    // properties (shorthand syntax)
    taglibHandlers['*'] = function(name, value) {
        var taglib = this.taglib;
        var path = this.path;

        if (name.startsWith('<')) {
            handleTag(this, name.slice(1, -1), value);
        } else if (name.startsWith('@')) {
            var attrName = name.substring(1);

            var attr = loader.attributeLoader.loadAttribute(
                attrName,
                value,
                '"' + attrName + '" attribute as part of ' + path);

            taglib.addAttribute(attr);
        } else {
            return false;
        }
    };

    propertyHandlers(taglibProps, taglibHandlers, path);

    taglib.path = path;

    if (!taglib.id) {
        // Fixes #73
        // See if there is a package.json in the same directory as the taglib file.
        // If so, and if that package.json file has a "name" property then we will
        // use the the name as the "taglib ID". The taglib ID is used to uniquely
        // identity a taglib (ignoring version) and it is used to prevent the same
        // taglib from being loaded multiple times.
        //
        // Using the file path as the taglib ID doesn't work so well since we might find
        // the same taglib multiple times in the Node.js module search path with
        // different paths.
        var dirname = nodePath.dirname(path);
        var packageJsonPath = nodePath.join(dirname, 'package.json');


        try {
            var pkg = require(packageJsonPath);
            taglib.id = pkg.name;
        } catch(e) {}

        if (!taglib.id) {
            taglib.id = path;
        }
    }

    return taglib;
};
});
$rmod.dep("", "raptor-polyfill", "1.0.2");
$rmod.def("/raptor-polyfill@1.0.2/string/startsWith", function(require, exports, module, __filename, __dirname) { if (!String.prototype.startsWith) {
    String.prototype.startsWith = function(prefix, position) {
        var str = this;
        
        if (position) {
            str = str.substring(position);
        }
        
        if (str.length < prefix.length) {
            return false;
        }
        
        return str.substring(0, prefix.length) == prefix;
    };
}
});
$rmod.main("/raptor-util@1.0.10", "raptor-util");
$rmod.def("/raptor-util@1.0.10/tryRequire", function(require, exports, module, __filename, __dirname) { 
module.exports = function(id, require) {
    var path;
    
    try {
        path = require.resolve(id);
    }
    catch(e) {}

    if (path) {
        return require(path);
    }
};
});
$rmod.def("/raptor-util@1.0.10/makeClass", function(require, exports, module, __filename, __dirname) { var inherit = require('./inherit');

module.exports = function(clazz) {
    var superclass;

    if (typeof clazz === 'function') {
        superclass = clazz.$super;
    }
    else {
        var o = clazz;
        clazz = o.$init || function() {};
        superclass = o.$super;

        delete o.$super;
        delete o.$init;

        clazz.prototype = o;
    }
    
    if (superclass) {
        inherit(clazz, superclass);
    }

    var proto = clazz.prototype;
    proto.constructor = clazz;
    
    return clazz;
};
});
$rmod.def("/raptor-util@1.0.10/makeEnum", function(require, exports, module, __filename, __dirname) { var makeClass = require('./makeClass');
var extend = require('./extend');
var forEachEntry = require('./forEachEntry');

module.exports = function(enumValues, Ctor) {
    if (Ctor) {
        Ctor = makeClass(Ctor);
    } else {
        Ctor = function () {};
    }

    var proto = Ctor.prototype;
    var count = 0;

    function _addEnumValue(name, EnumCtor) {
        var ordinal = count++;
        return extend(Ctor[name] = new EnumCtor(), {
            ordinal: ordinal,
            compareTo: function(other) {
                return ordinal - other.ordinal;
            },
            name: name
        });
    }

    function EnumCtor() {}

    if (Array.isArray(enumValues)) {
        enumValues.forEach(function (name) {
            _addEnumValue(name, Ctor);
        });
    } else if (enumValues) {
        EnumCtor.prototype = proto;
        forEachEntry(enumValues, function (name, args) {
            Ctor.apply(_addEnumValue(name, EnumCtor), args || []);
        });
    }

    Ctor.valueOf = function (name) {
        return Ctor[name];
    };


    if (proto.toString == Object.prototype.toString) {
        proto.toString = function() {
            return this.name;
        };
    }

    return Ctor;
};
});
$rmod.def("/raptor-util@1.0.10/forEach", function(require, exports, module, __filename, __dirname) { /**
 * Utility method to iterate over elements in an Array that
 * internally uses the "forEach" property of the array.
 *
 * <p>
 * If the input Array is null/undefined then nothing is done.
 *
 * <p>
 * If the input object does not have a "forEach" method then
 * it is converted to a single element Array and iterated over.
 *
 *
 * @param  {Array|Object} a An Array or an Object
 * @param  {Function} fun The callback function for each property
 * @param  {Object} thisp The "this" object to use for the callback function
 * @return {void}
 */
module.exports = function(a, func, thisp) {
    if (a != null) {
        (a.forEach ? a : [a]).forEach(func, thisp);
    }
};
});
$rmod.def("/raptor-util@1.0.10/arrayFromArguments", function(require, exports, module, __filename, __dirname) { var slice = [].slice;

module.exports = function(args, startIndex) {
    if (!args) {
        return [];
    }
    
    if (startIndex) {
        return startIndex < args.length ? slice.call(args, startIndex) : [];
    }
    else
    {
        return slice.call(args);
    }
};
});
$rmod.def("/raptor-util@1.0.10/attrs", function(require, exports, module, __filename, __dirname) { var attr = require('./attr');

module.exports = function(_attrs) {
    var out = '';
    for (var attrName in _attrs) {
        if (_attrs.hasOwnProperty(attrName)) {
            out += attr(attrName, _attrs[attrName]);
        }
    }
    return out;
};
});
$rmod.def("/raptor-util@1.0.10/toArray", function(require, exports, module, __filename, __dirname) { var slice = [].slice;

module.exports = function toArray(o) {
    if (o == null || Array.isArray(o)) {
        return o;
    }

    if (typeof o === 'string') {
        return o.split('');
    }

    if (o.length) {
        return slice.call(o, 0);
    }

    return [o];
};
});
$rmod.def("/raptor-util@1.0.10/raptor-util", function(require, exports, module, __filename, __dirname) { module.exports = {
    tryRequire: require('./tryRequire'),
    inherit: require('./inherit'),
    makeClass: require('./makeClass'),
    makeEnum: require('./makeEnum'),
    extend: require('./extend'),
    forEachEntry: require('./forEachEntry'),
    forEach: require('./forEach'),
    createError: require('./createError'),
    arrayFromArguments: require('./arrayFromArguments'),
    escapeXml: require('./escapeXml'),
    escapeXmlAttr: require('./escapeXml').attr,
    attr: require('./attr'),
    attrs: require('./attrs'),
    isObjectEmpty: require('./isObjectEmpty'),
    toArray: require('./toArray')
};
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/loader-tag", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

require('/$/raptor-polyfill/string/startsWith'/*'raptor-polyfill/string/startsWith'*/);
var ok = require('/$/assert'/*'assert'*/).ok;
var Taglib = require('./Taglib');
var propertyHandlers = require('/$/property-handlers'/*'property-handlers'*/);
var isObjectEmpty = require('/$/raptor-util/isObjectEmpty'/*'raptor-util/isObjectEmpty'*/);
var nodePath = require('path-browserify'/*'path'*/);
var resolve = require('../util/resolve'); // NOTE: different implementation for browser
var ok = require('/$/assert'/*'assert'*/).ok;
var bodyFunctionRegExp = /^([A-Za-z_$][A-Za-z0-9_]*)(?:\(([^)]*)\))?$/;
var safeVarName = /^[A-Za-z_$][A-Za-z0-9_]*$/;
var handleAttributes = require('./handleAttributes');
var Taglib = require('./Taglib');
var propertyHandlers = require('/$/property-handlers'/*'property-handlers'*/);
var forEachEntry = require('/$/raptor-util'/*'raptor-util'*/).forEachEntry;
var loader = require('./loader');
var markoCompiler = require('../');

function exists(path) {
    try {
        require.resolve(path);
        return true;
    } catch(e) {
        return false;
    }
}

function removeDashes(str) {
    return str.replace(/-([a-z])/g, function (match, lower) {
        return lower.toUpperCase();
    });
}

function handleVar(tag, value, path) {
    var nestedVariable;

    if (typeof value === 'string') {
        nestedVariable = {
            name: value
        };
    } else {
        nestedVariable = {};

        propertyHandlers(value, {

            name: function(value) {
                nestedVariable.name = value;
            },

            nameFromAttribute: function(value) {
                nestedVariable.nameFromAttribute = value;
            }

        }, path);

        if (!nestedVariable.name && !nestedVariable.nameFromAttribute) {
            throw new Error('The "name" or "name-from-attribute" attribute is required for a nested variable');
        }
    }

    tag.addNestedVariable(nestedVariable);
}


/**
 * We load tag definition using this class. Properties in the taglib
 * definition (which is just a JavaScript object with properties)
 * are mapped to handler methods in an instance of this type.
 *
 * @param {Tag} tag The initially empty Tag instance that we populate
 * @param {String} dirname The full file system path associated with the tag being loaded
 * @param {String} path An informational path associated with this tag (used for error reporting)
 */
function TagHandlers(tag, dirname, path, taglib) {
    this.tag = tag;
    this.dirname = dirname;
    this.path = path;
    this.taglib = taglib;

    if (!taglib) {
        throw new Error('taglib expected');
    }
}

TagHandlers.prototype = {
    /**
     * The tag name
     * @param {String} value The tag name
     */
    name: function(value) {
        var tag = this.tag;
        tag.name = value;
    },

    /**
     * The path to the renderer JS module to use for this tag.
     *
     * NOTE: We use the equivalent of require.resolve to resolve the JS module
     * 		 and use the tag directory as the "from".
     *
     * @param {String} value The renderer path
     */
    renderer: function(value) {
        var tag = this.tag;
        var dirname = this.dirname;
        var path = resolve(value, dirname);

        this.taglib.addInputFile(path);

        tag.renderer = path;
    },

    /**
     * A tag can use a renderer or a template to do the rendering. If
     * a template is provided then the value should be the path to the
     * template to use to render the custom tag.
     */
    template: function(value) {
        var tag = this.tag;
        var dirname = this.dirname;

        var path = nodePath.resolve(dirname, value);
        if (!exists(path)) {
            throw new Error('Template at path "' + path + '" does not exist.');
        }

        this.taglib.addInputFile(path);

        tag.template = path;
    },

    /**
     * An Object where each property maps to an attribute definition.
     * The property key will be the attribute name and the property value
     * will be the attribute definition. Example:
     * {
     *     "attributes": {
     *         "foo": "string",
     *         "bar": "expression"
     *     }
     * }
     */
    attributes: function(value) {
        var tag = this.tag;
        var path = this.path;

        handleAttributes(value, tag, path);
    },

    /**
     * A custom tag can be mapped to module that is is used
     * to generate compile-time code for the custom tag. A
     * node type is created based on the methods and methods
     * exported by the code codegen module.
     */
    codeGenerator: function(value) {
        var tag = this.tag;
        var dirname = this.dirname;

        var path = resolve(value, dirname);
        tag.codeGeneratorModulePath = path;
        this.taglib.addInputFile(path);
    },

    /**
     * A custom tag can be mapped to a compile-time Node that gets
     * added to the parsed Abstract Syntax Tree (AST). The Node can
     * then generate custom JS code at compile time. The value
     * should be a path to a JS module that gets resolved using the
     * equivalent of require.resolve(path)
     */
    nodeFactory: function(value) {
        var tag = this.tag;
        var dirname = this.dirname;

        var path = resolve(value, dirname);
        tag.nodeFactoryPath = path;
        this.taglib.addInputFile(path);
    },

    /**
     * If the "preserve-whitespace" property is set to true then
     * all whitespace nested below the custom tag in a template
     * will be stripped instead of going through the normal whitespace
     * removal rules.
     */
    preserveWhitespace: function(value) {
        var tag = this.tag;
        tag.preserveWhitespace = !!value;
    },

    /**
     * If a custom tag has an associated transformer then the transformer
     * will be called on the compile-time Node. The transformer can manipulate
     * the AST using the DOM-like API to change how the code gets generated.
     */
    transformer: function(value) {
        var tag = this.tag;
        var dirname = this.dirname;
        var path = this.path;
        var taglib = this.taglib;

        var transformer = new Taglib.Transformer();

        if (typeof value === 'string') {
            // The value is a simple string type
            // so treat the value as the path to the JS
            // module for the transformer
            value = {
                path: value
            };
        }

        /**
         * The transformer is a complex type and we need
         * to process each property to load the Transformer
         * definition.
         */
        propertyHandlers(value, {
            path: function(value) {
                var path = resolve(value, dirname);
                transformer.path = path;
                taglib.addInputFile(path);
            },

            priority: function(value) {
                transformer.priority = value;
            },

            name: function(value) {
                transformer.name = value;
            },

            properties: function(value) {
                var properties = transformer.properties || (transformer.properties = {});
                for (var k in value) {
                    if (value.hasOwnProperty(k)) {
                        properties[k] = value[k];
                    }
                }
            }

        }, 'transformer in ' + path);

        ok(transformer.path, '"path" is required for transformer');

        tag.addTransformer(transformer);
    },

    /**
     * The "var" property is used to declared nested variables that get
     * added as JavaScript variables at compile time.
     *
     * Examples:
     *
     * "var": "myScopedVariable",
     *
     * "var": {
     *     "name": "myScopedVariable"
     * }
     *
     * "var": {
     *     "name-from-attribute": "var"
     * }
     */
    'var': function(value) {
        handleVar(this.tag, value, '"var" in tag ' + this.path);
    },
    /**
     * The "vars" property is equivalent to the "var" property
     * except that it expects an array of nested variables.
     */
    vars: function(value) {
        var tag = this.tag;
        var self = this;

        if (value) {
            value.forEach(function(v, i) {
                handleVar(tag, v, '"vars"[' + i + '] in tag ' + self.path);
            });
        }
    },
    /**
     * The "body-function" property" allows the nested body content to be mapped
     * to a function at compile time. The body function gets mapped to a property
     * of the tag renderer at render time. The body function can have any number
     * of parameters.
     *
     * Example:
     * - "body-function": "_handleBody(param1, param2, param3)"
     */
    bodyFunction: function(value) {
        var tag = this.tag;
        var parts = bodyFunctionRegExp.exec(value);
        if (!parts) {
            throw new Error('Invalid value of "' + value + '" for "body-function". Expected value to be of the following form: <function-name>([param1, param2, ...])');
        }

        var functionName = parts[1];
        var params = parts[2];
        if (params) {
            params = params.trim().split(/\s*,\s*/);
            for (var i=0; i<params.length; i++) {
                if (params[i].length === 0) {
                    throw new Error('Invalid parameters for body-function with value of "' + value + '"');
                } else if (!safeVarName.test(params[i])) {
                    throw new Error('Invalid parameter name of "' + params[i] + '" for body-function with value of "' + value + '"');
                }
            }
        } else {
            params = [];
        }

        tag.setBodyFunction(functionName, params);
    },
    /**
     * The "import-var" property can be used to add a property to the
     * input object of the tag renderer whose value is determined by
     * a JavaScript expression.
     *
     * Example:
     * "import-var": {
     *     "myTargetProperty": "data.myCompileTimeJavaScriptExpression",
     * }
     */
    importVar: function(value) {
        var tag = this.tag;
        forEachEntry(value, function(varName, varValue) {
            var importedVar = {
                targetProperty: varName
            };

            var expression = varValue;

            if (!expression) {
                expression = varName;
            }
            else if (typeof expression === 'object') {
                expression = expression.expression;
            }

            if (!expression) {
                throw new Error('Invalid "import-var": ' + require('/$/util'/*'util'*/).inspect(varValue));
            }

            importedVar.expression = markoCompiler.builder.parseExpression(expression);
            tag.addImportedVariable(importedVar);
        });
    },
    /**
     * The tag type.
     */
    type: function(value) {
        var tag = this.tag;
        tag.type = value;
    },
    /**
     * Declare a nested tag.
     *
     * Example:
     * {
     *     ...
     *     "nested-tags": {
     *        "tab": {
     *            "target-property": "tabs",
     *            "isRepeated": true
     *        }
     *     }
     * }
     */
    nestedTags: function(value) {
        var tagPath = this.path;
        var taglib = this.taglib;
        var dirname = this.dirname;
        var tag = this.tag;

        forEachEntry(value, function(nestedTagName, nestedTagDef) {
            var nestedTag = loadTag(
                nestedTagDef,
                nestedTagName + ' of ' + tagPath,
                taglib,
                dirname);
            nestedTag.name = nestedTagName;
            tag.addNestedTag(nestedTag);
        });
    },
    escapeXmlBody: function(value) {
        if (value === false) {
            this.tag.escapeXmlBody = false;
        }
    },

    /**
     * Sends the body content type. This is used to control how the body
     * content is parsed.
     */
    body: function(value) {
        if (value === 'static-text' || value === 'parsed-text' || value === 'html') {
            this.tag.body = value;
        } else {
            throw new Error('Invalid value for "body". Allowed: "static-text", "parsed-text" or "html"');
        }
    },

    openTagOnly: function(value) {
        this.tag.openTagOnly = value;
    },

    noOutput: function(value) {
        this.tag.noOutput = value;
    }
};

exports.isSupportedProperty = function(name) {
    return TagHandlers.prototype.hasOwnProperty(name);
};

function hasAttributes(tagProps) {
    if (tagProps.attributes != null) {
        return true;
    }

    for (var name in tagProps) {
        if (tagProps.hasOwnProperty(name) && name.startsWith('@')) {
            return true;
        }
    }

    return false;
}

function loadTag(tagProps, path, taglib, dirname) {
    ok(tagProps);
    ok(typeof path === 'string');
    ok(taglib);
    ok(typeof dirname === 'string');

    var tag = new Taglib.Tag(taglib);



    if (!hasAttributes(tagProps)) {
        // allow any attributes if no attributes are declared
        tagProps.attributes = {
            '*': {
                type: 'string',
                targetProperty: null,
                preserveName: false
            }
        };
    }

    var tagHandlers = new TagHandlers(tag, dirname, path, taglib);

    // We add a handler for any properties that didn't match
    // one of the default property handlers. This is used to
    // match properties in the form of "@attr_name" or
    // "<nested_tag_name>"
    tagHandlers['*'] = function(name, value) {
        var parts = name.split(/\s+|\s+[,]\s+/);

        var i;
        var part;

        var hasNestedTag = false;
        var hasAttr = false;
        var nestedTagTargetProperty = null;

        // We do one pass to figure out if there is an
        // attribute or nested tag or both
        for (i=0; i<parts.length; i++) {
            part = parts[i];
            if (part.startsWith('@')) {
                hasAttr = true;

                if (i === 0) {
                    // Use the first attribute value as the name of the target property
                    nestedTagTargetProperty = part.substring(1);
                }
            } else if (part.startsWith('<')) {
                hasNestedTag = true;
            } else {
                // Unmatched property that is not an attribute or a
                // nested tag
                return false;
            }
        }

        var attrProps = {};
        var tagProps = {};
        var k;

        if (value != null && typeof value === 'object') {
            for (k in value) {
                if (value.hasOwnProperty(k)) {
                    if (k.startsWith('@') || k.startsWith('<')) {
                        // Move over all of the attributes and nested tags
                        // to the tag definition.
                        tagProps[k] = value[k];
                        delete value[k];
                    } else {
                        // The property is not a shorthand attribute or shorthand
                        // tag so move it over to either the tag definition
                        // or the attribute definition or both the tag definition
                        // and attribute definition.
                        var propNameDashes = removeDashes(k);

                        if (loader.tagLoader.isSupportedProperty(propNameDashes) &&
                            loader.attributeLoader.isSupportedProperty(propNameDashes)) {
                            // Move over all of the properties that are associated with a tag
                            // and attribute
                            tagProps[k] = value[k];
                            attrProps[k] = value[k];
                            delete value[k];
                        } else if (loader.tagLoader.isSupportedProperty(propNameDashes)) {
                            // Move over all of the properties that are associated with a tag
                            tagProps[k] = value[k];
                            delete value[k];
                        } else if (loader.attributeLoader.isSupportedProperty(propNameDashes)) {
                            // Move over all of the properties that are associated with an attr
                            attrProps[k] = value[k];
                            delete value[k];
                        }
                    }
                }
            }

            // If there are any left over properties then something is wrong
            // with the user's taglib.
            if (!isObjectEmpty(value)) {
                throw new Error('Unsupported properties of [' +
                    Object.keys(value).join(', ') +
                    '] for "' + name + '" in "'  + path + '"');
            }

            var type = attrProps.type;
            if (!type && hasAttr && hasNestedTag) {
                // If we have an attribute and a nested tag then default
                // the attribute type to "expression"
                attrProps.type = 'expression';
            }
        } else if (typeof value === 'string') {
            if (hasNestedTag && hasAttr) {
                tagProps = attrProps = {
                    type: value
                };
            } else if (hasNestedTag) {
                tagProps = {
                    type: value
                };
            } else {
                attrProps = {
                    type: value
                };
            }
        }

        // Now that we have separated out attribute properties and tag properties
        // we need to create the actual attributes and nested tags
        for (i=0; i<parts.length; i++) {
            part = parts[i];
            if (part.startsWith('@')) {
                // This is a shorthand attribute
                var attrName = part.substring(1);

                var attr = loader.attributeLoader.loadAttribute(
                    attrName,
                    attrProps,
                    '"' + attrName + '" attribute as part of ' + path);

                tag.addAttribute(attr);
            } else if (part.startsWith('<')) {

                // This is a shorthand nested tag
                var nestedTag = loadTag(
                    tagProps,
                    name + ' of ' + path,
                    taglib,
                    dirname);

                // We use the '[]' suffix to indicate that a nested tag
                // can be repeated
                var isNestedTagRepeated = false;
                if (part.endsWith('[]')) {
                    isNestedTagRepeated = true;
                    part = part.slice(0, -2);
                }

                var nestedTagName = part.substring(1, part.length-1);
                nestedTag.name = nestedTagName;
                nestedTag.isRepeated = isNestedTagRepeated;
                // Use the name of the attribute as the target property unless
                // this target property was explicitly provided
                nestedTag.targetProperty = attrProps.targetProperty || nestedTagTargetProperty;
                tag.addNestedTag(nestedTag);
            } else {
                return false;
            }
        }
    };

    propertyHandlers(tagProps, tagHandlers, path);

    return tag;
}

exports.loadTag = loadTag;
});
$rmod.main("/raptor-regexp@1.0.1", "lib/raptor-regexp");
$rmod.dep("", "raptor-regexp", "1.0.1");
$rmod.def("/raptor-regexp@1.0.1/lib/raptor-regexp", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


var simpleSpecial = {
    "*": ".*?",
    "?": ".?"
};

module.exports = {
    
    /**
     * Escapes special regular expression characters in a string so that the resulting string can be used
     * as a literal in a constructed RegExp object.
     * 
     * Example:
     * <js>
     * strings.escapeRegExp("hello{world}");
     * //output: "hello\{world\}"
     * </js>
     * @param str The string to escape
     * @returns {String} The string with all special regular expression characters escaped
     */
    escape: function(str) {
        return str.replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g, "\\$&");
    },
    
    /**
     * Converts a string consisting of two types of wildcards to a regular expression:
     * Question Mark (?) - Represents a single character that can be any character
     * Asterisk (*) - This represents any sequence of characters 
     * 
     * @param {String} str The string that represents the simple regular expression
     * @return {RegExp} The resulting regular expression
     */
    simple: function(str) {
        var _this = this;
        
        return new RegExp("^" + str.replace(/[\*\?]|[^\*\?]*/g, function(match) {
            return simpleSpecial[match] || _this.escape(match);
        }) + "$");
    }
    
};

});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/loader-attribute", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

var assert = require('/$/assert'/*'assert'*/);
var raptorRegexp = require('/$/raptor-regexp'/*'raptor-regexp'*/);
var propertyHandlers = require('/$/property-handlers'/*'property-handlers'*/);
var Taglib = require('./Taglib');

function AttrHandlers(attr){
    assert.ok(attr);
    assert.equal(typeof attr, 'object');
    this.attr = attr;
}

AttrHandlers.prototype = {
    /**
     * The attribute type. One of the following:
     * - string (the default)
     * - expression (a JavaScript expression)
     * - number
     * - integer
     * - int
     * - boolean
     * - float
     * - double
     * - object
     * - array
     *
     */
    type: function(value) {
        var attr = this.attr;
        attr.type = value;
    },

    /**
     * The name of the target property to use when mapping
     * the attribute to a property on the target object.
     */
    targetProperty: function(value) {
        var attr = this.attr;
        attr.targetProperty = value;
    },
    /**
     * The "default-value" property allows a default value
     * to be provided when the attribute is not declared
     * on the custom tag.
     */
    defaultValue: function(value) {
        var attr = this.attr;
        attr.defaultValue = value;
    },
    /**
     * The "pattern" property allows the attribute
     * to be matched based on a simplified regular expression.
     *
     * Example:
     *
     * "pattern": "myprefix-*"
     */
    pattern: function(value) {
        var attr = this.attr;
        if (value === true) {
            var patternRegExp = raptorRegexp.simple(attr.name);
            attr.pattern = patternRegExp;
        }
    },

    /**
     * If "allow-expressions" is set to true (the default) then
     * the the attribute value will be parsed to find any dynamic
     * parts.
     */
    allowExpressions: function(value) {
        var attr = this.attr;
        attr.allowExpressions = value;
    },

    /**
     * By default, the Marko compiler maps an attribute
     * to a property by removing all dashes from the attribute
     * name and converting each character after a dash to
     * an uppercase character (e.g. "my-attr" --> "myAttr").
     *
     * Setting "preserve-name" to true will prevent this from
     * happening for the attribute.
     */
    preserveName: function(value) {
        var attr = this.attr;
        attr.preserveName = value;
    },
    /**
     * Declares an attribute as required. Currently, this is
     * not enforced and is only used for documentation purposes.
     *
     * Example:
     * "required": true
     */
    required: function(value) {
        var attr = this.attr;
        attr.required = value === true;
    },
    /**
     * This is the opposite of "preserve-name" and will result
     * in dashes being removed from the attribute if set to true.
     */
    removeDashes: function(value) {
        var attr = this.attr;
        attr.removeDashes = value === true;
    },
    /**
     * The description of the attribute. Only used for documentation.
     */
    description: function() {

    },

    /**
     * The "set-flag" property allows a "flag" to be added to a Node instance
     * at compile time if the attribute is found on the node. This is helpful
     * if an attribute uses a pattern and a transformer wants to have a simple
     * check to see if the Node has an attribute that matched the pattern.
     *
     * Example:
     *
     * "set-flag": "myCustomFlag"
     *
     * A Node instance can be checked if it has a flag set as shown below:
     *
     * if (node.hasFlag('myCustomFlag')) { ... }
     *
     *
     */
    setFlag: function(value) {
        var attr = this.attr;
        attr.setFlag = value;
    },
    /**
     * An attribute can be marked for ignore. Ignored attributes
     * will be ignored during compilation.
     */
    ignore: function(value) {
        var attr = this.attr;
        if (value === true) {
            attr.ignore = true;
        }
    }
};

exports.isSupportedProperty = function(name) {
    return AttrHandlers.prototype.hasOwnProperty(name);
};

exports.loadAttribute = function loadAttribute(attrName, attrProps, path) {
    var attr = new Taglib.Attribute(attrName);

    if (attrProps == null) {
        attrProps = {
            type: 'string'
        };
    } else if (typeof attrProps === 'string') {
        attrProps = {
            type: attrProps
        };
    }

    var attrHandlers = new AttrHandlers(attr);
    propertyHandlers(attrProps, attrHandlers, path);
    return attr;
};
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/loader", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
* 
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
* 
*    http://www.apache.org/licenses/LICENSE-2.0
* 
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

exports.taglibLoader = require('./loader-taglib');
exports.tagLoader = require('./loader-tag');
exports.attributeLoader = require('./loader-attribute');
});
$rmod.def("/marko@3.3.0/compiler/taglib-loader/index", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

var loader = require('./loader');
var Taglib = require('./Taglib');

var cache = {};

function load(path) {
    // Only load a taglib once by caching the loaded taglibs using the file
    // system path as the key
    if (cache[path]) {
        return cache[path];
    }

    var taglib = cache[path] = new Taglib(path);

    loader.taglibLoader.loadTaglib(path, taglib);

    cache[path] = taglib;

    return taglib;
}

exports.clearCache = function() {
    cache = {};
};

exports.load = load;

});
$rmod.main("/marko@3.3.0/compiler/taglib-finder", "index");
$rmod.remap("/marko@3.3.0/compiler/taglib-finder/index", "index-browser");
$rmod.def("/marko@3.3.0/compiler/taglib-finder/index-browser", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

function find(dirname, registeredTaglibs) {
    return registeredTaglibs || [];
}

function excludeDir(dirname) {
    // no-op
}

function clearCache() {
    // no-op
}


exports.find = find;
exports.excludeDir = excludeDir;
exports.clearCache = clearCache;
});
$rmod.def("/marko@3.3.0/taglibs/core/marko", {
    "<assign>": {
        "code-generator": "./assign-tag"
    },
    "<else>": {
        "node-factory": "./else-tag"
    },
    "<else-if>": {
        "node-factory": "./else-if-tag"
    },
    "<for>": {
        "code-generator": "./for-tag"
    },
    "<if>": {
        "node-factory": "./if-tag"
    },
    "<include>": {
        "code-generator": "./include-tag"
    },
    "<include-text>": {
        "code-generator": "./include-text-tag"
    },
    "<invoke>": {
        "code-generator": "./invoke-tag"
    },
    "<macro>": {
        "code-generator": "./macro-tag"
    },
    "<macro-body>": {
        "code-generator": "./macro-body-tag"
    },
    "<marko-preserve-whitespace>": {
        "code-generator": "./marko-preserve-whitespace-tag",
        "preserve-whitespace": true
    },
    "<pre>": {
        "preserve-whitespace": true
    },
    "<script>": {
        "preserve-whitespace": true,
        "@marko-init": "boolean",
        "@*": {
            "ignore": true
        }
    },
    "<style>": {
        "preserve-whitespace": true
    },
    "<textarea>": {
        "preserve-whitespace": true
    },
    "<unless>": {
        "node-factory": "./unless-tag"
    },
    "<var>": {
        "node-factory": "./var-tag"
    },
    "<while>": {
        "code-generator": "./while-tag"
    },
    "<*>": {
        "@if": "argument",
        "@else-if": "argument",
        "@else": "argument",
        "@for": "argument",
        "@while": "argument",
        "transformer": {
            "path": "./core-transformer",
            "priority": 0
        }
    }
});
$rmod.def("/marko@3.3.0/taglibs/layout/marko", {
    "<layout-use>": {
        "@__template": "template",
        "@__data": "template",
        "@*": {
            "remove-dashes": true,
            "type": "string"
        },
        "renderer": "./use-tag",
        "body-function": "getContent(__layoutHelper)",
        "transformer": "./use-tag-transformer.js"
    },
    "<layout-put>": {
        "@into": "string",
        "@value": "string",
        "renderer": "./put-tag",
        "import-var": {
            "layout": "__layoutHelper"
        }
    },
    "<layout-placeholder>": {
        "@name": "string",
        "renderer": "./placeholder-tag",
        "import-var": {
            "content": "data.layoutContent"
        }
    }
});
$rmod.def("/marko@3.3.0/taglibs/html/marko", {
    "taglib-id": "marko-html",
    "<html-comment>": {
        "renderer": "./html-comment-tag.js"
    }
});
$rmod.def("/marko@3.3.0/taglibs/async/marko", {
    "<async-fragment>": {
        "renderer": "./async-fragment-tag",
        "@data-provider": "expression",
        "@arg": {
            "type": "expression",
            "preserve-name": true
        },
        "@arg-*": {
            "pattern": true,
            "type": "string",
            "preserve-name": true
        },
        "@var": "identifier",

        "@method": "string",

        "@timeout": "integer",

        "@timeout-message": "string",
        "@error-message": "string",
        "@placeholder": "string",

        "@renderTimeout": "function",
        "@renderError": "function",
        "@renderPlaceholder": "function",

        "@name": {
            "type": "string",
            "description": "Name of async fragment"
        },
        "@_name": "string",
        "@client-reorder": {
            "type": "boolean",
            "description": "Use JavaScript on client to move async fragment into the proper place."
        },
        "@scope": {
            "type": "expression",
            "description": "The value of 'this' when invoking the data provider function (N/A with promises)"
        },
        "@show-after": {
            "type": "string"
        },

        "vars": [{
            "name-from-attribute": "var"
        }],
        "transformer": "./async-fragment-tag-transformer"
    },
    "<async-fragments>": {
        "renderer": "./async-fragments-tag"
    },
    "<async-fragment-placeholder>": {
        "transformer": "./async-fragment-nested-tag-transformer"
    },
    "<async-fragment-timeout>": {
        "transformer": "./async-fragment-nested-tag-transformer"
    },
    "<async-fragment-error>": {
        "transformer": "./async-fragment-nested-tag-transformer"
    }
});
$rmod.def("/marko@3.3.0/taglibs/cache/default-cache-manager", function(require, exports, module, __filename, __dirname) { var caches = {};

function createCache() {
    var cache = {};

    return {
        get: function(cacheKey, options, callback) {
            var value = cache[cacheKey];
            if (value !== undefined) {
                return callback(null, value);
            }

            var builder = options.builder;
            builder(function(err, value) {
                if (err) {
                    return callback(err);
                }

                if (value === undefined) {
                    value = null;
                }

                cache[cacheKey] = value;

                callback(null, value);
            });
        }
    };
}

var defaultCacheManager = {
    getCache: function(cacheName) {
        return caches[cacheName] || (caches[cacheName] = createCache());
    }
};

module.exports = defaultCacheManager;
});
$rmod.def("/marko@3.3.0/taglibs/cache/cached-fragment-tag-transformer", function(require, exports, module, __filename, __dirname) { var defaultCacheManagerPath = require.resolve('./default-cache-manager');

module.exports = function(el, context) {
    if (!el.hasAttribute('cache-manager')) {
        var requirePath = context.getRequirePath(defaultCacheManagerPath);
        var defaultCacheManagerVar = context.importModule('__defaultCacheManager', requirePath);
        el.setAttributeValue('cache-manager', defaultCacheManagerVar);
    }
};
});
$rmod.def("/marko@3.3.0/taglibs/cache/cached-fragment-tag", function(require, exports, module, __filename, __dirname) { /*
* Copyright 2011 eBay Software Foundation
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*    http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

'use strict';
module.exports = {
    render: function (input, out) {
        var cacheKey = input.cacheKey;
        if (!cacheKey) {
            throw new Error('cache-key is required for <cached-fragment>');
        }

        var cacheManager = input.cacheManager;

        var cache = cacheManager.getCache(input.cacheName || 'marko/cached-fragment');

        var asyncOut = out.beginAsync();

        cache.get(cacheKey,
            {
                builder: function(callback) {
                    var result = out.captureString(function () {
                        if (input.renderBody) {
                            input.renderBody(out);
                        }
                    });
                    callback(null, result);
                }
            }, function(err, result) {
                if (err) {
                    return asyncOut.error(err);
                }

                asyncOut.end(result);
            });
    }
};

});
$rmod.def("/marko@3.3.0/taglibs/cache/marko", {
    "<cached-fragment>": {
        "renderer": "./cached-fragment-tag",
        "@cache-key": "string",
        "@cache-name": "string",
        "@cache-manager": "string",
        "transformer": "./cached-fragment-tag-transformer.js"
    }
});
$rmod.def("/marko@3.3.0/compiler/index", function(require, exports, module, __filename, __dirname) { 'use strict';

var Compiler = require('./Compiler');
var Walker = require('./Walker');
var Parser = require('./Parser');
var HtmlJsParser = require('./HtmlJsParser');
var Builder = require('./Builder');
var extend = require('/$/raptor-util/extend'/*'raptor-util/extend'*/);
var CompileContext = require('./CompileContext');
var globalConfig = require('./config');
var defaults = extend({}, globalConfig);

Object.defineProperty(exports, 'defaultOptions', {
    get: function() { return globalConfig;  },
    enumerable: true,
    configurable: false
});

Object.defineProperty(exports, 'config', {
    get: function() { return globalConfig;  },
    enumerable: true,
    configurable: false
});

var defaultParser = new Parser(new HtmlJsParser());
var rawParser = new Parser(
    new HtmlJsParser({
        ignorePlaceholders: true
    }),
    {
        raw: true
    });



function configure(newConfig) {
    if (!newConfig) {
        newConfig = {};
    }

    extend(globalConfig, defaults);
    extend(globalConfig, newConfig);
}

var defaultCompiler = new Compiler({
    parser: defaultParser,
    builder: Builder.DEFAULT_BUILDER
});

var req = require;

function createBuilder(options) {
    return new Builder(options);
}

function createWalker(options) {
    return new Walker(options);
}

function compileFile(filename, options, callback) {
    var fs = req('fs');
    var compiler;

    if (typeof options === 'function') {
        callback = options;
        options = null;
    }

    if (options) {
        compiler = options.compiler;
    }

    if (!compiler) {
        compiler = defaultCompiler;
    }

    if (callback) {
        fs.readFile(filename, {encoding: 'utf8'}, function(err, templateSrc) {
            if (err) {
                return callback(err);
            }

            try {
                callback(null, compiler.compile(templateSrc, filename, options));
            } catch(e) {
                callback(e);
            }
        });
    } else {
        let templateSrc = fs.readFileSync(filename, {encoding: 'utf8'});
        return compiler.compile(templateSrc, filename, options);
    }
}

function compile(src, filename, options, callback) {
    var compiler;

    if (typeof options === 'function') {
        callback = options;
        options = null;
    }

    if (options) {
        compiler = options.compiler;
    }

    if (!compiler) {
        compiler = defaultCompiler;
    }

    if (callback) {
        try {
            callback(null, compiler.compile(src, filename, options));
        } catch(e) {
            callback(e);
        }
    } else {
        return compiler.compile(src, filename, options);
    }
}

function checkUpToDate(templateFile, templateJsFile) {
    return false; // TODO Implement checkUpToDate
}

function getLastModified(path, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = null;
    }

    callback(null, -1); // TODO Implement getLastModified
}

function clearCaches() {
    exports.taglibLookup.clearCache();
    exports.taglibFinder.clearCache();
    exports.taglibLoader.clearCache();
}

function parseRaw(templateSrc, filename) {
    var context = new CompileContext(templateSrc, filename, Builder.DEFAULT_BUILDER);
    var parsed = rawParser.parse(templateSrc, context);

    if (context.hasErrors()) {
        var errors = context.getErrors();

        var message = 'An error occurred while trying to compile template at path "' + filename + '". Error(s) in template:\n';
        for (var i = 0, len = errors.length; i < len; i++) {
            let error = errors[i];
            message += (i + 1) + ') ' + error.toString() + '\n';
        }
        var error = new Error(message);
        error.errors = errors;
        throw error;
    }

    return parsed;
}

exports.createBuilder = createBuilder;
exports.compileFile = compileFile;
exports.compile = compile;
exports.parseRaw = parseRaw;

exports.checkUpToDate = checkUpToDate;
exports.getLastModified = getLastModified;
exports.createWalker = createWalker;
exports.builder = Builder.DEFAULT_BUILDER;
exports.configure = configure;
exports.clearCaches = clearCaches;

var taglibLookup = require('./taglib-lookup');
exports.taglibLookup = taglibLookup;
exports.taglibLoader = require('./taglib-loader');
exports.taglibFinder = require('./taglib-finder');

function buildTaglibLookup(dirname) {
    return taglibLookup.buildLookup(dirname);
}

exports.buildTaglibLookup = buildTaglibLookup;

taglibLookup.registerTaglib(require.resolve('../taglibs/core/marko.json'));
taglibLookup.registerTaglib(require.resolve('../taglibs/layout/marko.json'));
taglibLookup.registerTaglib(require.resolve('../taglibs/html/marko.json'));
taglibLookup.registerTaglib(require.resolve('../taglibs/async/marko.json'));
taglibLookup.registerTaglib(require.resolve('../taglibs/cache/marko.json'));

exports.registerTaglib = function(path) {
    taglibLookup.registerTaglib(path);
    clearCaches();
};

/*
exports.Taglib = require('./Taglib');

exports.lookup = require('./taglib-lookup');
exports.buildLookup = exports.lookup.buildLookup;
exports.registerTaglib = exports.lookup.registerTaglib;
exports.excludeDir = exports.lookup.excludeDir;
exports.clearCaches = function() {
    exports.lookup.clearCaches();
    require('./taglib-finder').clearCaches();
};
*/
});
$rmod.main("/marko-widgets@6.1.0", "lib/index");
$rmod.dep("", "marko-widgets", "6.1.0");
$rmod.def("/marko-widgets@6.1.0/lib/client-init", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

require('./init-widgets').initServerRendered();
});
$rmod.run("/$/marko-widgets/lib/client-init");
$rmod.main("/raptor-pubsub@1.0.5", "lib/index");
$rmod.dep("", "raptor-pubsub", "1.0.5");
$rmod.def("/raptor-pubsub@1.0.5/lib/raptor-pubsub", function(require, exports, module, __filename, __dirname) { var EventEmitter = require('/$/events'/*'events'*/).EventEmitter;

var channels = {};

var globalChannel = new EventEmitter();

globalChannel.channel = function(name) {
    var channel;
    if (name) {
        channel = channels[name] || (channels[name] = new EventEmitter());
    } else {
        channel = new EventEmitter();
    }
    return channel;
};

globalChannel.removeChannel = function(name) {
    delete channels[name];
};

module.exports = globalChannel;

});
$rmod.def("/raptor-pubsub@1.0.5/lib/index", function(require, exports, module, __filename, __dirname) { var g = typeof window === 'undefined' ? global : window;
// Make this module a true singleton
module.exports = g.__RAPTOR_PUBSUB || (g.__RAPTOR_PUBSUB = require('./raptor-pubsub'));
});
$rmod.main("/raptor-dom@1.1.1", "raptor-dom-server");
$rmod.dep("", "raptor-dom", "1.1.1");
$rmod.def("/raptor-dom@1.1.1/ready", function(require, exports, module, __filename, __dirname) { /*
    jQuery's doc.ready/$(function(){}) should
    you wish to use a cross-browser domReady solution
    without opting for a library.

    Demo: http://jsfiddle.net/zKLpb/

    usage:
    $(function(){
        // your code
    });

    Parts: jQuery project, Diego Perini, Lucent M.
    Previous version from Addy Osmani (https://raw.github.com/addyosmani/jquery.parts/master/jquery.documentReady.js)

    This version: Patrick Steele-Idem
    - Converted to CommonJS module
    - Code cleanup
    - Fixes for IE <=10
*/

var isReady = false;
var readyBound = false;

var win = window;
var doc = document;

var listeners = [];

function domReadyCallback() {
    for (var i = 0, len = listeners.length; i < len; i++) {
        var listener = listeners[i];
        listener[0].call(listener[1]);
    }
    listeners = null;
}

// Handle when the DOM is ready
function domReady() {
    // Make sure that the DOM is not already loaded
    if (!isReady) {
        // Make sure body exists, at least, in case IE gets a little overzealous (ticket #5443).
        if (!doc.body) {
            return setTimeout(domReady, 1);
        }
        // Remember that the DOM is ready
        isReady = true;
        // If there are functions bound, to execute
        domReadyCallback();
        // Execute all of them
    }
} // /ready()

// The ready event handler
function domContentLoaded() {
    if (doc.addEventListener) {
        doc.removeEventListener("DOMContentLoaded", domContentLoaded, false);
    } else {
        // we're here because readyState !== "loading" in oldIE
        // which is good enough for us to call the dom ready!
        doc.detachEvent("onreadystatechange", domContentLoaded);
    }
    domReady();
}

// The DOM ready check for Internet Explorer
function doScrollCheck() {
    if (isReady) {
        return;
    }

    try {
        // If IE is used, use the trick by Diego Perini
        // http://javascript.nwbox.com/IEContentLoaded/
        doc.documentElement.doScroll("left");
    } catch (error) {
        setTimeout(doScrollCheck, 1);
        return;
    }
    // and execute any waiting functions
    domReady();
}

function bindReady() {
    var toplevel = false;

    // Catch cases where $ is called after the
    // browser event has already occurred. IE <= 10 has a bug that results in 'interactive' being assigned
    // to the readyState before the DOM is really ready
    if (document.attachEvent ? document.readyState === "complete" : document.readyState !== "loading") {
        // We will get here if the browser is IE and the readyState === 'complete' or the browser
        // is not IE and the readyState === 'interactive' || 'complete'
        domReady();
    } else if (doc.addEventListener) { // Standards-based browsers support DOMContentLoaded
        // Use the handy event callback
        doc.addEventListener("DOMContentLoaded", domContentLoaded, false);
        // A fallback to win.onload, that will always work
        win.addEventListener("load", domContentLoaded, false);
        // If IE event model is used
    } else if (doc.attachEvent) {
        // ensure firing before onload,
        // maybe late but safe also for iframes
        doc.attachEvent("onreadystatechange", domContentLoaded);
        // A fallback to win.onload, that will always work
        win.attachEvent("onload", domContentLoaded);
        // If IE and not a frame
        // continually check to see if the document is ready
        try {
            toplevel = win.frameElement == null;
        } catch (e) {}
        if (doc.documentElement.doScroll && toplevel) {
            doScrollCheck();
        }
    }
}

module.exports = function(callback, thisObj) {
    if (isReady) {
        return callback.call(thisObj);
    }

    listeners.push([callback, thisObj]);

    if (!readyBound) {
        readyBound = true;
        bindReady();
    }
};
});
$rmod.remap("/raptor-dom@1.1.1/raptor-dom-server", "raptor-dom-client");
$rmod.def("/raptor-dom@1.1.1/raptor-dom-client", function(require, exports, module, __filename, __dirname) { var raptorPubsub = require('/$/raptor-pubsub'/*'raptor-pubsub'*/);

function getNode(el) {
    if (typeof el === 'string') {
        var elId = el;
        el = document.getElementById(elId);
        if (!el) {
            throw new Error('Target element not found: "' + elId + '"');
        }
    }
    return el;
}

function _beforeRemove(referenceEl) {
    if (raptorPubsub) {
        raptorPubsub.emit('dom/beforeRemove', {
            el: referenceEl
        });
    }
}

var dom = {
    forEachChildEl: function(node, callback, scope) {
        dom.forEachChild(node, callback, scope, 1);
    },
    forEachChild: function(node, callback, scope, nodeType) {
        if (!node) {
            return;
        }
        var i = 0;
        var childNodes = node.childNodes;
        var len = childNodes.length;
        for (; i < len; i++) {
            var childNode = childNodes[i];
            if (childNode && (nodeType == null || nodeType == childNode.nodeType)) {
                callback.call(scope, childNode);
            }
        }
    },
    detach: function(child) {
        child = getNode(child);
        child.parentNode.removeChild(child);
    },
    appendTo: function(newChild, referenceParentEl) {
        getNode(referenceParentEl).appendChild(getNode(newChild));
    },
    remove: function(el) {
        el = getNode(el);
        _beforeRemove(el);
        if (el.parentNode) {
            el.parentNode.removeChild(el);
        }
    },
    removeChildren: function(parentEl) {
        parentEl = getNode(parentEl);

        var i = 0;
        var childNodes = parentEl.childNodes;
        var len = childNodes.length;
        for (; i < len; i++) {
            var childNode = childNodes[i];
            if (childNode && childNode.nodeType === 1) {
                _beforeRemove(childNode);
            }
        }
        parentEl.innerHTML = '';
    },
    replace: function(newChild, replacedChild) {
        replacedChild = getNode(replacedChild);
        _beforeRemove(replacedChild);
        replacedChild.parentNode.replaceChild(getNode(newChild), replacedChild);
    },
    replaceChildrenOf: function(newChild, referenceParentEl) {
        referenceParentEl = getNode(referenceParentEl);
        dom.forEachChildEl(referenceParentEl, function(childEl) {
            _beforeRemove(childEl);
        });
        referenceParentEl.innerHTML = '';
        referenceParentEl.appendChild(getNode(newChild));
    },
    insertBefore: function(newChild, referenceChild) {
        referenceChild = getNode(referenceChild);
        referenceChild.parentNode.insertBefore(getNode(newChild), referenceChild);
    },
    insertAfter: function(newChild, referenceChild) {
        referenceChild = getNode(referenceChild);
        newChild = getNode(newChild);
        var nextSibling = referenceChild.nextSibling;
        var parentNode = referenceChild.parentNode;
        if (nextSibling) {
            parentNode.insertBefore(newChild, nextSibling);
        } else {
            parentNode.appendChild(newChild);
        }
    },
    prependTo: function(newChild, referenceParentEl) {
        referenceParentEl = getNode(referenceParentEl);
        referenceParentEl.insertBefore(getNode(newChild), referenceParentEl.firstChild || null);
    }
};

/*
var jquery = window.$;
if (!jquery) {
    try {
        jquery = require('jquery');
    }
    catch(e) {}
}

if (jquery) {
    dom.ready = function(callback, thisObj) {
        jquery(function() {
            callback.call(thisObj);
        });
    };
} else {
    dom.ready = require('./raptor-dom_documentReady');
}
*/
dom.ready = require('./ready');

module.exports = dom;
});
$rmod.main("/marko-widgets@6.1.0/lib", "index");
$rmod.main("/listener-tracker@1.0.5", "lib/listener-tracker");
$rmod.dep("", "listener-tracker", "1.0.5");
$rmod.def("/listener-tracker@1.0.5/lib/listener-tracker", function(require, exports, module, __filename, __dirname) { var INDEX_EVENT = 0;
var INDEX_USER_LISTENER = 1;
var INDEX_WRAPPED_LISTENER = 2;

function EventEmitterWrapper(target) {
    this._target = target;
    this._listeners = [];
    this._subscribeTo = null;
}

EventEmitterWrapper.prototype = {
    _onProxy: function(type, event, listener) {
        this._target[type](event, listener);
        this._listeners.push([event, listener]);
        return this;
    },

    _remove: function(test, testWrapped) {
        var target = this._target;
        var listeners = this._listeners;

        this._listeners = listeners.filter(function(curListener) {
            var curEvent = curListener[INDEX_EVENT];
            var curListenerFunc = curListener[INDEX_USER_LISTENER];
            var curWrappedListenerFunc = curListener[INDEX_WRAPPED_LISTENER];

            if (testWrapped) {
                // If the user used `once` to attach an event listener then we had to
                // wrap their listener function with a new function that does some extra
                // cleanup to avoid a memory leak. If the `testWrapped` flag is set to true
                // then we are attempting to remove based on a function that we had to
                // wrap (not the user listener function)
                if (curWrappedListenerFunc && test(curEvent, curWrappedListenerFunc)) {
                    target.removeListener(curEvent, curWrappedListenerFunc);
                    return false;
                }
            } else if (test(curEvent, curListenerFunc)) {
                // If the listener function was wrapped due to it being a `once` listener
                // then we should remove from the target EventEmitter using wrapped
                // listener function. Otherwise, we remove the listener using the user-provided
                // listener function.
                target.removeListener(curEvent, curWrappedListenerFunc || curListenerFunc);
                return false;
            }

            return true;
        });

        // Fixes https://github.com/raptorjs/listener-tracker/issues/2
        // If all of the listeners stored with a wrapped EventEmitter
        // have been removed then we should unregister the wrapped
        // EventEmitter in the parent SubscriptionTracker
        var subscribeTo = this._subscribeTo;

        if (this._listeners.length === 0 && subscribeTo) {
            var self = this;
            var subscribeToList = subscribeTo._subscribeToList;
            subscribeTo._subscribeToList = subscribeToList.filter(function(cur) {
                return cur !== self;
            });
        }
    },

    on: function(event, listener) {
        return this._onProxy('on', event, listener);
    },

    once: function(event, listener) {
        var self = this;

        // Handling a `once` event listener is a little tricky since we need to also
        // do our own cleanup if the `once` event is emitted. Therefore, we need
        // to wrap the user's listener function with our own listener function.
        var wrappedListener = function() {
            self._remove(function(event, listenerFunc) {
                return wrappedListener === listenerFunc;
            }, true /* We are removing the wrapped listener */);

            listener.apply(this, arguments);
        };

        this._target.once(event, wrappedListener);
        this._listeners.push([event, listener, wrappedListener]);
        return this;
    },

    removeListener: function(event, listener) {
        if (typeof event === 'function') {
            listener = event;
            event = null;
        }

        if (listener && event) {
            this._remove(function(curEvent, curListener) {
                return event === curEvent && listener === curListener;
            });
        } else if (listener) {
            this._remove(function(curEvent, curListener) {
                return listener === curListener;
            });
        } else if (event) {
            this.removeAllListeners(event);
        }

        return this;
    },

    removeAllListeners: function(event) {

        var listeners = this._listeners;
        var target = this._target;

        if (event) {
            this._remove(function(curEvent, curListener) {
                return event === curEvent;
            });
        } else {
            for (var i = listeners.length - 1; i >= 0; i--) {
                var cur = listeners[i];
                target.removeListener(cur[INDEX_EVENT], cur[INDEX_USER_LISTENER]);
            }
            this._listeners.length = 0;
        }

        return this;
    }
};

EventEmitterWrapper.prototype.addListener = EventEmitterWrapper.prototype.on;

function SubscriptionTracker() {
    this._subscribeToList = [];
}

SubscriptionTracker.prototype = {

    subscribeTo: function(target, options) {
        var addDestroyListener = !options || options.addDestroyListener !== false;

        var wrapper;
        var subscribeToList = this._subscribeToList;

        for (var i=0, len=subscribeToList.length; i<len; i++) {
            var cur = subscribeToList[i];
            if (cur._target === target) {
                wrapper = cur;
                break;
            }
        }

        if (!wrapper) {
            wrapper = new EventEmitterWrapper(target);
            if (addDestroyListener) {
                wrapper.once('destroy', function() {
                    wrapper.removeAllListeners();

                    for (var i = subscribeToList.length - 1; i >= 0; i--) {
                        if (subscribeToList[i]._target === target) {
                            subscribeToList.splice(i, 1);
                            break;
                        }
                    }
                });
            }

            // Store a reference to the parent SubscriptionTracker so that we can do cleanup
            // if the EventEmitterWrapper instance becomes empty (i.e., no active listeners)
            wrapper._subscribeTo = this;
            subscribeToList.push(wrapper);
        }

        return wrapper;
    },

    removeAllListeners: function(target, event) {
        var subscribeToList = this._subscribeToList;
        var i;

        if (target) {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                var cur = subscribeToList[i];
                if (cur._target === target) {
                    cur.removeAllListeners(event);

                    if (!cur._listeners.length) {
                        // Do some cleanup if we removed all
                        // listeners for the target event emitter
                        subscribeToList.splice(i, 1);
                    }

                    break;
                }
            }
        } else {

            for (i = subscribeToList.length - 1; i >= 0; i--) {
                subscribeToList[i].removeAllListeners();
            }
            subscribeToList.length = 0;
        }
    }
};

exports.wrap = function(targetEventEmitter) {
    var wrapper = new EventEmitterWrapper(targetEventEmitter);
    targetEventEmitter.once('destroy', function() {
        wrapper._listeners.length = 0;
    });
    return wrapper;
};

exports.createTracker = function() {
    return new SubscriptionTracker();
};
});
$rmod.main("/morphdom@1.3.0", "lib/index");
$rmod.dep("", "morphdom", "1.3.0");
$rmod.def("/morphdom@1.3.0/lib/index", function(require, exports, module, __filename, __dirname) { // Create a range object for efficently rendering strings to elements.
var range;

var testEl = typeof document !== 'undefined' ? document.body || document.createElement('div') : {};

// Fixes https://github.com/patrick-steele-idem/morphdom/issues/32 (IE7+ support)
// <=IE7 does not support el.hasAttribute(name)
var hasAttribute;
if (testEl.hasAttribute) {
    hasAttribute = function hasAttribute(el, name) {
        return el.hasAttribute(name);
    };
} else {
    hasAttribute = function hasAttribute(el, name) {
        return el.getAttributeNode(name);
    };
}

function empty(o) {
    for (var k in o) {
        if (o.hasOwnProperty(k)) {
            return false;
        }
    }

    return true;
}
function toElement(str) {
    if (!range && document.createRange) {
        range = document.createRange();
        range.selectNode(document.body);
    }

    var fragment;
    if (range && range.createContextualFragment) {
        fragment = range.createContextualFragment(str);
    } else {
        fragment = document.createElement('body');
        fragment.innerHTML = str;
    }
    return fragment.childNodes[0];
}

var specialElHandlers = {
    /**
     * Needed for IE. Apparently IE doesn't think
     * that "selected" is an attribute when reading
     * over the attributes using selectEl.attributes
     */
    OPTION: function(fromEl, toEl) {
        if ((fromEl.selected = toEl.selected)) {
            fromEl.setAttribute('selected', '');
        } else {
            fromEl.removeAttribute('selected', '');
        }
    },
    /**
     * The "value" attribute is special for the <input> element
     * since it sets the initial value. Changing the "value"
     * attribute without changing the "value" property will have
     * no effect since it is only used to the set the initial value.
     * Similar for the "checked" attribute.
     */
    INPUT: function(fromEl, toEl) {
        fromEl.checked = toEl.checked;

        if (fromEl.value != toEl.value) {
            fromEl.value = toEl.value;
        }

        if (!hasAttribute(toEl, 'checked')) {
            fromEl.removeAttribute('checked');
        }

        if (!hasAttribute(toEl, 'value')) {
            fromEl.removeAttribute('value');
        }
    },

    TEXTAREA: function(fromEl, toEl) {
        var newValue = toEl.value;
        if (fromEl.value != newValue) {
            fromEl.value = newValue;
        }

        if (fromEl.firstChild) {
            fromEl.firstChild.nodeValue = newValue;
        }
    }
};

function noop() {}

/**
 * Loop over all of the attributes on the target node and make sure the
 * original DOM node has the same attributes. If an attribute
 * found on the original node is not on the new node then remove it from
 * the original node
 * @param  {HTMLElement} fromNode
 * @param  {HTMLElement} toNode
 */
function morphAttrs(fromNode, toNode) {
    var attrs = toNode.attributes;
    var i;
    var attr;
    var attrName;
    var attrValue;
    var foundAttrs = {};

    for (i=attrs.length-1; i>=0; i--) {
        attr = attrs[i];
        if (attr.specified !== false) {
            attrName = attr.name;
            attrValue = attr.value;
            foundAttrs[attrName] = true;

            if (fromNode.getAttribute(attrName) !== attrValue) {
                fromNode.setAttribute(attrName, attrValue);
            }
        }
    }

    // Delete any extra attributes found on the original DOM element that weren't
    // found on the target element.
    attrs = fromNode.attributes;

    for (i=attrs.length-1; i>=0; i--) {
        attr = attrs[i];
        if (attr.specified !== false) {
            attrName = attr.name;
            if (!foundAttrs.hasOwnProperty(attrName)) {
                fromNode.removeAttribute(attrName);
            }
        }
    }
}

/**
 * Copies the children of one DOM element to another DOM element
 */
function moveChildren(fromEl, toEl) {
    var curChild = fromEl.firstChild;
    while(curChild) {
        var nextChild = curChild.nextSibling;
        toEl.appendChild(curChild);
        curChild = nextChild;
    }
    return toEl;
}

function defaultGetNodeKey(node) {
    return node.id;
}

function morphdom(fromNode, toNode, options) {
    if (!options) {
        options = {};
    }

    if (typeof toNode === 'string') {
        if (fromNode.nodeName === '#document' || fromNode.nodeName === 'HTML') {
            var toNodeHtml = toNode;
            toNode = document.createElement('html');
            toNode.innerHTML = toNodeHtml;
        } else {
            toNode = toElement(toNode);
        }
    }

    var savedEls = {}; // Used to save off DOM elements with IDs
    var unmatchedEls = {};
    var getNodeKey = options.getNodeKey || defaultGetNodeKey;
    var onBeforeNodeAdded = options.onBeforeNodeAdded || noop;
    var onNodeAdded = options.onNodeAdded || noop;
    var onBeforeElUpdated = options.onBeforeElUpdated || options.onBeforeMorphEl || noop;
    var onElUpdated = options.onElUpdated || noop;
    var onBeforeNodeDiscarded = options.onBeforeNodeDiscarded || noop;
    var onNodeDiscarded = options.onNodeDiscarded || noop;
    var onBeforeElChildrenUpdated = options.onBeforeElChildrenUpdated || options.onBeforeMorphElChildren || noop;
    var childrenOnly = options.childrenOnly === true;
    var movedEls = [];

    function removeNodeHelper(node, nestedInSavedEl) {
        var id = getNodeKey(node);
        // If the node has an ID then save it off since we will want
        // to reuse it in case the target DOM tree has a DOM element
        // with the same ID
        if (id) {
            savedEls[id] = node;
        } else if (!nestedInSavedEl) {
            // If we are not nested in a saved element then we know that this node has been
            // completely discarded and will not exist in the final DOM.
            onNodeDiscarded(node);
        }

        if (node.nodeType === 1) {
            var curChild = node.firstChild;
            while(curChild) {
                removeNodeHelper(curChild, nestedInSavedEl || id);
                curChild = curChild.nextSibling;
            }
        }
    }

    function walkDiscardedChildNodes(node) {
        if (node.nodeType === 1) {
            var curChild = node.firstChild;
            while(curChild) {


                if (!getNodeKey(curChild)) {
                    // We only want to handle nodes that don't have an ID to avoid double
                    // walking the same saved element.

                    onNodeDiscarded(curChild);

                    // Walk recursively
                    walkDiscardedChildNodes(curChild);
                }

                curChild = curChild.nextSibling;
            }
        }
    }

    function removeNode(node, parentNode, alreadyVisited) {
        if (onBeforeNodeDiscarded(node) === false) {
            return;
        }

        parentNode.removeChild(node);
        if (alreadyVisited) {
            if (!getNodeKey(node)) {
                onNodeDiscarded(node);
                walkDiscardedChildNodes(node);
            }
        } else {
            removeNodeHelper(node);
        }
    }

    function morphEl(fromEl, toEl, alreadyVisited, childrenOnly) {
        var toElKey = getNodeKey(toEl);
        if (toElKey) {
            // If an element with an ID is being morphed then it is will be in the final
            // DOM so clear it out of the saved elements collection
            delete savedEls[toElKey];
        }

        if (!childrenOnly) {
            if (onBeforeElUpdated(fromEl, toEl) === false) {
                return;
            }

            morphAttrs(fromEl, toEl);
            onElUpdated(fromEl);

            if (onBeforeElChildrenUpdated(fromEl, toEl) === false) {
                return;
            }
        }

        if (fromEl.tagName != 'TEXTAREA') {
            var curToNodeChild = toEl.firstChild;
            var curFromNodeChild = fromEl.firstChild;
            var curToNodeId;

            var fromNextSibling;
            var toNextSibling;
            var savedEl;
            var unmatchedEl;

            outer: while(curToNodeChild) {
                toNextSibling = curToNodeChild.nextSibling;
                curToNodeId = getNodeKey(curToNodeChild);

                while(curFromNodeChild) {
                    var curFromNodeId = getNodeKey(curFromNodeChild);
                    fromNextSibling = curFromNodeChild.nextSibling;

                    if (!alreadyVisited) {
                        if (curFromNodeId && (unmatchedEl = unmatchedEls[curFromNodeId])) {
                            unmatchedEl.parentNode.replaceChild(curFromNodeChild, unmatchedEl);
                            morphEl(curFromNodeChild, unmatchedEl, alreadyVisited);
                            curFromNodeChild = fromNextSibling;
                            continue;
                        }
                    }

                    var curFromNodeType = curFromNodeChild.nodeType;

                    if (curFromNodeType === curToNodeChild.nodeType) {
                        var isCompatible = false;

                        if (curFromNodeType === 1) { // Both nodes being compared are Element nodes
                            if (curFromNodeChild.tagName === curToNodeChild.tagName) {
                                // We have compatible DOM elements
                                if (curFromNodeId || curToNodeId) {
                                    // If either DOM element has an ID then we handle
                                    // those differently since we want to match up
                                    // by ID
                                    if (curToNodeId === curFromNodeId) {
                                        isCompatible = true;
                                    }
                                } else {
                                    isCompatible = true;
                                }
                            }

                            if (isCompatible) {
                                // We found compatible DOM elements so transform the current "from" node
                                // to match the current target DOM node.
                                morphEl(curFromNodeChild, curToNodeChild, alreadyVisited);
                            }
                        } else if (curFromNodeType === 3) { // Both nodes being compared are Text nodes
                            isCompatible = true;
                            // Simply update nodeValue on the original node to change the text value
                            curFromNodeChild.nodeValue = curToNodeChild.nodeValue;
                        }

                        if (isCompatible) {
                            curToNodeChild = toNextSibling;
                            curFromNodeChild = fromNextSibling;
                            continue outer;
                        }
                    }

                    // No compatible match so remove the old node from the DOM and continue trying
                    // to find a match in the original DOM
                    removeNode(curFromNodeChild, fromEl, alreadyVisited);
                    curFromNodeChild = fromNextSibling;
                }

                if (curToNodeId) {
                    if ((savedEl = savedEls[curToNodeId])) {
                        morphEl(savedEl, curToNodeChild, true);
                        curToNodeChild = savedEl; // We want to append the saved element instead
                    } else {
                        // The current DOM element in the target tree has an ID
                        // but we did not find a match in any of the corresponding
                        // siblings. We just put the target element in the old DOM tree
                        // but if we later find an element in the old DOM tree that has
                        // a matching ID then we will replace the target element
                        // with the corresponding old element and morph the old element
                        unmatchedEls[curToNodeId] = curToNodeChild;
                    }
                }

                // If we got this far then we did not find a candidate match for our "to node"
                // and we exhausted all of the children "from" nodes. Therefore, we will just
                // append the current "to node" to the end
                if (onBeforeNodeAdded(curToNodeChild) !== false) {
                    fromEl.appendChild(curToNodeChild);
                    onNodeAdded(curToNodeChild);
                }

                if (curToNodeChild.nodeType === 1 && (curToNodeId || curToNodeChild.firstChild)) {
                    // The element that was just added to the original DOM may have
                    // some nested elements with a key/ID that needs to be matched up
                    // with other elements. We'll add the element to a list so that we
                    // can later process the nested elements if there are any unmatched
                    // keyed elements that were discarded
                    movedEls.push(curToNodeChild);
                }

                curToNodeChild = toNextSibling;
                curFromNodeChild = fromNextSibling;
            }

            // We have processed all of the "to nodes". If curFromNodeChild is non-null then
            // we still have some from nodes left over that need to be removed
            while(curFromNodeChild) {
                fromNextSibling = curFromNodeChild.nextSibling;
                removeNode(curFromNodeChild, fromEl, alreadyVisited);
                curFromNodeChild = fromNextSibling;
            }
        }

        var specialElHandler = specialElHandlers[fromEl.tagName];
        if (specialElHandler) {
            specialElHandler(fromEl, toEl);
        }
    } // END: morphEl(...)

    var morphedNode = fromNode;
    var morphedNodeType = morphedNode.nodeType;
    var toNodeType = toNode.nodeType;

    if (!childrenOnly) {
        // Handle the case where we are given two DOM nodes that are not
        // compatible (e.g. <div> --> <span> or <div> --> TEXT)
        if (morphedNodeType === 1) {
            if (toNodeType === 1) {
                if (fromNode.tagName !== toNode.tagName) {
                    onNodeDiscarded(fromNode);
                    morphedNode = moveChildren(fromNode, document.createElement(toNode.tagName));
                }
            } else {
                // Going from an element node to a text node
                morphedNode = toNode;
            }
        } else if (morphedNodeType === 3) { // Text node
            if (toNodeType === 3) {
                morphedNode.nodeValue = toNode.nodeValue;
                return morphedNode;
            } else {
                // Text node to something else
                morphedNode = toNode;
            }
        }
    }

    if (morphedNode === toNode) {
        // The "to node" was not compatible with the "from node"
        // so we had to toss out the "from node" and use the "to node"
        onNodeDiscarded(fromNode);
    } else {
        morphEl(morphedNode, toNode, false, childrenOnly);

        /**
         * What we will do here is walk the tree for the DOM element
         * that was moved from the target DOM tree to the original
         * DOM tree and we will look for keyed elements that could
         * be matched to keyed elements that were earlier discarded.
         * If we find a match then we will move the saved element
         * into the final DOM tree
         */
        var handleMovedEl = function(el) {
            var curChild = el.firstChild;
            while(curChild) {
                var nextSibling = curChild.nextSibling;

                var key = getNodeKey(curChild);
                if (key) {
                    var savedEl = savedEls[key];
                    if (savedEl && (curChild.tagName === savedEl.tagName)) {
                        curChild.parentNode.replaceChild(savedEl, curChild);
                        morphEl(savedEl, curChild, true /* already visited the saved el tree */);
                        curChild = nextSibling;
                        if (empty(savedEls)) {
                            return false;
                        }
                        continue;
                    }
                }

                if (curChild.nodeType === 1) {
                    handleMovedEl(curChild);
                }

                curChild = nextSibling;
            }
        };

        // The loop below is used to possibly match up any discarded
        // elements in the original DOM tree with elemenets from the
        // target tree that were moved over without visiting their
        // children
        if (!empty(savedEls)) {
            handleMovedElsLoop:
            while (movedEls.length) {
                var movedElsTemp = movedEls;
                movedEls = [];
                for (var i=0; i<movedElsTemp.length; i++) {
                    if (handleMovedEl(movedElsTemp[i]) === false) {
                        // There are no more unmatched elements so completely end
                        // the loop
                        break handleMovedElsLoop;
                    }
                }
            }
        }

        // Fire the "onNodeDiscarded" event for any saved elements
        // that never found a new home in the morphed DOM
        for (var savedElId in savedEls) {
            if (savedEls.hasOwnProperty(savedElId)) {
                var savedEl = savedEls[savedElId];
                onNodeDiscarded(savedEl);
                walkDiscardedChildNodes(savedEl);
            }
        }
    }

    if (!childrenOnly && morphedNode !== fromNode && fromNode.parentNode) {
        // If we had to swap out the from node with a new node because the old
        // node was not compatible with the target node then we need to
        // replace the old DOM node in the original DOM tree. This is only
        // possible if the original DOM node was part of a DOM tree which
        // we know is the case if it has a parent node.
        fromNode.parentNode.replaceChild(morphedNode, fromNode);
    }

    return morphedNode;
}

module.exports = morphdom;

});
$rmod.def("/marko-widgets@6.1.0/lib/Widget", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var inherit = require('/$/raptor-util/inherit'/*'raptor-util/inherit'*/);
var raptorDom = require('/$/raptor-dom'/*'raptor-dom'*/);
var markoWidgets = require('./');
var raptorRenderer = require('/$/raptor-renderer'/*'raptor-renderer'*/);
var EventEmitter = require('/$/events'/*'events'*/).EventEmitter;
var listenerTracker = require('/$/listener-tracker'/*'listener-tracker'*/);
var arrayFromArguments = require('/$/raptor-util/arrayFromArguments'/*'raptor-util/arrayFromArguments'*/);
var extend = require('/$/raptor-util/extend'/*'raptor-util/extend'*/);
var updateManager = require('./update-manager');
var morphdom = require('/$/morphdom'/*'morphdom'*/);

var MORPHDOM_SKIP = false;

var WIDGET_SUBSCRIBE_TO_OPTIONS = null;
var NON_WIDGET_SUBSCRIBE_TO_OPTIONS = {
    addDestroyListener: false
};


var emit = EventEmitter.prototype.emit;
var idRegExp = /^\#(\w+)( .*)?/;

var lifecycleEventMethods = {
    'beforeDestroy': 'onBeforeDestroy',
    'destroy': 'onDestroy',
    'beforeUpdate': 'onBeforeUpdate',
    'update': 'onUpdate',
    'render': 'onRender',
    'beforeInit': 'onBeforeInit',
    'afterInit': 'onAfterInit'
};

function removeListener(eventListenerHandle) {
    eventListenerHandle.remove();
}

function destroyRecursive(el) {
    raptorDom.forEachChildEl(el, function (childEl) {
        var descendentWidget = childEl.__widget;
        if (descendentWidget) {
            destroy(descendentWidget, false, false);
        }
        destroyRecursive(childEl);
    });
}

/**
 * This method handles invoking a widget's event handler method
 * (if present) while also emitting the event through
 * the standard EventEmitter.prototype.emit method.
 *
 * Special events and their corresponding handler methods
 * include the following:
 *
 * beforeDestroy --> onBeforeDestroy
 * destroy       --> onDestroy
 * beforeUpdate  --> onBeforeUpdate
 * update        --> onUpdate
 * render        --> onRender
 */
function emitLifecycleEvent(widget, eventType, eventArg) {
    var listenerMethod = widget[lifecycleEventMethods[eventType]];

    if (listenerMethod) {
        listenerMethod.call(widget, eventArg);
    }

    widget.emit(eventType, eventArg);
}

function removeDOMEventListeners(widget) {
    var eventListenerHandles = widget.__evHandles;
    if (eventListenerHandles) {
        eventListenerHandles.forEach(removeListener);
        widget.__evHandles = null;
    }
}

function destroy(widget, removeNode, recursive) {
    if (widget.isDestroyed()) {
        return;
    }

    var rootEl = widget.getEl();

    emitLifecycleEvent(widget, 'beforeDestroy');
    widget.__lifecycleState = 'destroyed';

    if (rootEl) {
        if (recursive) {
            destroyRecursive(rootEl);
        }

        if (removeNode && rootEl.parentNode) {
            //Remove the widget's DOM nodes from the DOM tree if the root element is known
            rootEl.parentNode.removeChild(rootEl);
        }

        rootEl.__widget = null;
    }

    // Unsubscribe from all DOM events
    removeDOMEventListeners(widget);

    if (widget.__subscriptions) {
        widget.__subscriptions.removeAllListeners();
        widget.__subscriptions = null;
    }

    emitLifecycleEvent(widget, 'destroy');
}

function setState(widget, name, value, forceDirty, noQueue) {
    if (typeof value === 'function') {
        return;
    }

    if (value === null) {
        // Treat null as undefined to simplify our comparison logic
        value = undefined;
    }

    if (forceDirty) {
        var dirtyState = widget.__dirtyState || (widget.__dirtyState = {});
        dirtyState[name] = true;
    } else if (widget.state[name] === value) {
        return;
    }

    var clean = !widget.__dirty;

    if (clean) {
        // This is the first time we are modifying the widget state
        // so introduce some properties to do some tracking of
        // changes to the state
        var currentState = widget.state;
        widget.__dirty = true; // Mark the widget state as dirty (i.e. modified)
        widget.__oldState = currentState;
        widget.state = extend({}, currentState);
        widget.__stateChanges = {};
    }

    widget.__stateChanges[name] = value;

    if (value == null) {
        // Don't store state properties with an undefined or null value
        delete widget.state[name];
    } else {
        // Otherwise, store the new value in the widget state
        widget.state[name] = value;
    }

    if (clean && noQueue !== true) {
        // If we were clean before then we are now dirty so queue
        // up the widget for update
        updateManager.queueWidgetUpdate(widget);
    }
}

function replaceState(widget, newState, noQueue) {
    var k;

    for (k in widget.state) {
        if (widget.state.hasOwnProperty(k) && !newState.hasOwnProperty(k)) {
            setState(widget, k, undefined, false, noQueue);
        }
    }

    for (k in newState) {
        if (newState.hasOwnProperty(k)) {
            setState(widget, k, newState[k], false, noQueue);
        }
    }
}

function resetWidget(widget) {
    widget.__oldState = null;
    widget.__dirty = false;
    widget.__stateChanges = null;
    widget.__newProps = null;
    widget.__dirtyState = null;
}

function hasCompatibleWidget(widgetsContext, existingWidget) {
    var id = existingWidget.id;
    var newWidgetDef = widgetsContext.getWidget(id);
    if (!newWidgetDef) {
        return false;
    }

    return existingWidget.__type === newWidgetDef.type;
}

var widgetProto;

/**
 * Base widget type.
 *
 * NOTE: Any methods that are prefixed with an underscore should be considered private!
 */
function Widget(id, document) {
    EventEmitter.call(this);
    this.id = id;
    this.el = null;
    this.bodyEl = null;
    this.state = null;
    this.__subscriptions = null;
    this.__evHandles = null;
    this.__lifecycleState = null;
    this.__customEvents = null;
    this.__scope = null;
    this.__dirty = false;
    this.__oldState = null;
    this.__stateChanges = null;
    this.__updateQueued = false;
    this.__dirtyState = null;
    this.__document = document;
}

Widget.prototype = widgetProto = {
    _isWidget: true,

    subscribeTo: function(target) {
        if (!target) {
            throw new Error('target is required');
        }

        var tracker = this.__subscriptions;
        if (!tracker) {
            this.__subscriptions = tracker = listenerTracker.createTracker();
        }


        var subscribeToOptions = target._isWidget ?
            WIDGET_SUBSCRIBE_TO_OPTIONS :
            NON_WIDGET_SUBSCRIBE_TO_OPTIONS;

        return tracker.subscribeTo(target, subscribeToOptions);
    },

    emit: function(eventType) {
        var customEvents = this.__customEvents;
        var targetMethodName;
        var args;

        if (customEvents && (targetMethodName = customEvents[eventType])) {
            args = args || arrayFromArguments(arguments, 1);
            args.push(this);

            var targetWidget = markoWidgets.getWidgetForEl(this.__scope);
            var targetMethod = targetWidget[targetMethodName];
            if (!targetMethod) {
                throw new Error('Method not found for widget ' + targetWidget.id + ': ' + targetMethodName);
            }

            targetMethod.apply(targetWidget, args);
        }

        return emit.apply(this, arguments);
    },
    getElId: function (widgetElId, index) {
        var elId = widgetElId != null ? this.id + '-' + widgetElId : this.id;

        if (index != null) {
            elId += '[' + index + ']';
        }

        return elId;
    },
    getEl: function (widgetElId, index) {
        if (widgetElId != null) {
            return this.__document.getElementById(this.getElId(widgetElId, index));
        } else {
            return this.el || this.__document.getElementById(this.getElId());
        }
    },
    getEls: function(id) {
        var els = [];
        var i=0;
        while(true) {
            var el = this.getEl(id, i);
            if (!el) {
                break;
            }
            els.push(el);
            i++;
        }
        return els;
    },
    getWidget: function(id, index) {
        var targetWidgetId = this.getElId(id, index);
        return markoWidgets.getWidgetForEl(targetWidgetId, this.__document);
    },
    getWidgets: function(id) {
        var widgets = [];
        var i=0;
        while(true) {
            var widget = this.getWidget(id, i);
            if (!widget) {
                break;
            }
            widgets.push(widget);
            i++;
        }
        return widgets;
    },
    destroy: function (options) {
        options = options || {};
        destroy(this, options.removeNode !== false, options.recursive !== false);
    },
    isDestroyed: function () {
        return this.__lifecycleState === 'destroyed';
    },
    getBodyEl: function() {
        return this.bodyEl;
    },
    setState: function(name, value) {
        if (typeof name === 'object') {
            // Merge in the new state with the old state
            var newState = name;
            for (var k in newState) {
                if (newState.hasOwnProperty(k)) {
                    setState(this, k, newState[k]);
                }
            }
            return;
        }

        setState(this, name, value);
    },

    setStateDirty: function(name, value) {
        if (arguments.length === 1) {
            value = this.state[name];
        }

        setState(this, name, value, true /* forceDirty */);
    },

    _replaceState: function(newState) {
        replaceState(this, newState, true /* do not queue an update */ );
    },

    _removeDOMEventListeners: function() {
        removeDOMEventListeners(this);
    },

    replaceState: function(newState) {
        replaceState(this, newState);
    },

    /**
     * Recalculate the new state from the given props using the widget's
     * getInitialState(props) method. If the widget does not have a
     * getInitialState(props) then it is re-rendered with the new props
     * as input.
     *
     * @param {Object} props The widget's new props
     */
    setProps: function(newProps) {
        if (this.getInitialState) {
            if (this.getInitialProps) {
                newProps = this.getInitialProps(newProps) || {};
            }
            var newState = this.getInitialState(newProps);
            this.replaceState(newState);
            return;
        }

        if (!this.__newProps) {
            updateManager.queueWidgetUpdate(this);
        }

        this.__newProps = newProps;
    },

    update: function() {
        var newProps = this.__newProps;

        if (this.shouldUpdate(newProps, this.state) === false) {
            resetWidget(this);
            return;
        }

        if (newProps) {
            resetWidget(this);
            this.rerender(newProps);
            return;
        }

        if (!this.__dirty) {
            // Don't even bother trying to update this widget since it is
            // not marked as dirty.
            return;
        }

        if (!this._processUpdateHandlers()) {
            this.doUpdate(this.__stateChanges, this.__oldState);
        }

        // Reset all internal properties for tracking state changes, etc.
        resetWidget(this);
    },

    isDirty: function() {
        return this.__dirty;
    },

    _reset: function() {
        resetWidget(this);
    },

    /**
     * This method is used to process "update_<stateName>" handler functions.
     * If all of the modified state properties have a user provided update handler
     * then a rerender will be bypassed and, instead, the DOM will be updated
     * looping over and invoking the custom update handlers.
     * @return {boolean} Returns true if if the DOM was updated. False, otherwise.
     */
    _processUpdateHandlers: function() {
        var stateChanges = this.__stateChanges;
        var oldState = this.__oldState;

        var handlerMethod;
        var handlers = [];

        var newValue;
        var oldValue;

        for (var propName in stateChanges) {
            if (stateChanges.hasOwnProperty(propName)) {
                newValue = stateChanges[propName];
                oldValue = oldState[propName];

                if (oldValue === newValue) {
                    // Only do an update for this state property if it is actually
                    // different from the old state or if it was forced to be dirty
                    // using setStateDirty(propName)
                    var dirtyState = this.__dirtyState;
                    if (dirtyState == null || !dirtyState.hasOwnProperty(propName)) {
                        continue;
                    }
                }

                var handlerMethodName = 'update_' + propName;

                handlerMethod = this[handlerMethodName];
                if (handlerMethod) {
                    handlers.push([propName, handlerMethod]);
                } else {
                    // This state change does not have a state handler so return false
                    // to force a rerender
                    return false;
                }
            }
        }

        // If we got here then all of the changed state properties have
        // an update handler or there are no state properties that actually
        // changed.

        if (!handlers.length) {
            return true;
        }

        // Otherwise, there are handlers for all of the changed properties
        // so apply the updates using those handlers

        emitLifecycleEvent(this, 'beforeUpdate');

        for (var i=0, len=handlers.length; i<len; i++) {
            var handler = handlers[i];
            var propertyName = handler[0];
            handlerMethod = handler[1];

            newValue = stateChanges[propertyName];
            oldValue = oldState[propertyName];
            handlerMethod.call(this, newValue, oldValue);
        }

        emitLifecycleEvent(this, 'update');

        resetWidget(this);

        return true;
    },

    shouldUpdate: function(newState, newProps) {
        return true;
    },

    doUpdate: function (stateChanges, oldState) {
        this.rerender();
    },

    _emitLifecycleEvent: function(eventType, eventArg) {
        emitLifecycleEvent(this, eventType, eventArg);
    },

    rerender: function(props) {
        var self = this;

        if (!self.renderer) {
            throw new Error('Widget does not have a "renderer" property');
        }

        var elToReplace = this.__document.getElementById(self.id);

        var renderer = self.renderer || self;
        self.__lifecycleState = 'rerender';

        var templateData = extend({}, props || self.state);

        var global = templateData.$global = {};

        global.__rerenderWidget = self;
        global.__rerenderEl = self.el;
        global.__rerender = true;

        if (!props) {
            global.__rerenderState = props ? null : self.state;
        }

        updateManager.batchUpdate(function() {
            var renderResult = raptorRenderer
                .render(renderer, templateData);

            var newNode = renderResult.getNode(self.__document);

            var out = renderResult.out;
            var widgetsContext = out.global.widgets;

            function onNodeDiscarded(node) {
                var widget = node.__widget;
                if (widget) {
                    destroy(widget, false, false);
                }
            }

            function onBeforeMorphEl(fromEl, toEl) {
                var id = fromEl.id;
                var existingWidget;

                var preservedAttrs = toEl.getAttribute('data-w-preserve-attrs');
                if (preservedAttrs) {
                    preservedAttrs = preservedAttrs.split(/\s*[,]\s*/);
                    for (var i=0; i<preservedAttrs.length; i++) {
                        var preservedAttrName = preservedAttrs[i];
                        var preservedAttrValue = fromEl.getAttribute(preservedAttrName);
                        if (preservedAttrValue == null) {
                            toEl.removeAttribute(preservedAttrName);
                        } else {
                            toEl.setAttribute(preservedAttrName, preservedAttrValue);
                        }

                    }
                }

                if (widgetsContext && id) {
                    if (widgetsContext.isPreservedEl(id)) {

                        if (widgetsContext.hasUnpreservedBody(id)) {
                            existingWidget = fromEl.__widget;

                            morphdom(existingWidget.bodyEl, toEl, {
                                childrenOnly: true,
                                onNodeDiscarded: onNodeDiscarded,
                                onBeforeMorphEl: onBeforeMorphEl,
                                onBeforeMorphElChildren: onBeforeMorphElChildren
                            });
                        }

                        // Don't morph elements that are associated with widgets that are being
                        // reused or elements that are being preserved. For widgets being reused,
                        // the morphing will take place when the reused widget updates.
                        return MORPHDOM_SKIP;
                    } else {
                        existingWidget = fromEl.__widget;
                        if (existingWidget && !hasCompatibleWidget(widgetsContext, existingWidget)) {
                            // We found a widget in an old DOM node that does not have
                            // a compatible widget that was rendered so we need to
                            // destroy the old widget
                            destroy(existingWidget, false, false);
                        }
                    }
                }
            }

            function onBeforeMorphElChildren(el) {
                if (widgetsContext && el.id) {
                    if (widgetsContext.isPreservedBodyEl(el.id)) {
                        // Don't morph the children since they are preserved
                        return MORPHDOM_SKIP;
                    }
                }
            }

            morphdom(elToReplace, newNode, {
                onNodeDiscarded: onNodeDiscarded,
                onBeforeMorphEl: onBeforeMorphEl,
                onBeforeMorphElChildren: onBeforeMorphElChildren
            });

            // Trigger any 'onUpdate' events for all of the rendered widgets
            renderResult.afterInsert(self.__document);

            self.__lifecycleState = null;

            if (!props) {
                // We have re-rendered with the new state so our state
                // is no longer dirty. Before updating a widget
                // we check if a widget is dirty. If a widget is not
                // dirty then we abort the update. Therefore, if the
                // widget was queued for update and the re-rendered
                // before the update occurred then nothing will happen
                // at the time of the update.
                resetWidget(self);
            }
        });
    },

    detach: function () {
        raptorDom.detach(this.el);

    },
    appendTo: function (targetEl) {
        raptorDom.appendTo(this.el, targetEl);
    },
    replace: function (targetEl) {
        raptorDom.replace(this.el, targetEl);
    },
    replaceChildrenOf: function (targetEl) {
        raptorDom.replaceChildrenOf(this.el, targetEl);
    },
    insertBefore: function (targetEl) {
        raptorDom.insertBefore(this.el, targetEl);
    },
    insertAfter: function (targetEl) {
        raptorDom.insertAfter(this.el, targetEl);
    },
    prependTo: function (targetEl) {
        raptorDom.prependTo(this.el, targetEl);
    },
    ready: function (callback) {
        markoWidgets.ready(callback, this);
    },
    $: function (arg) {
        var jquery = markoWidgets.$;

        var args = arguments;
        if (args.length === 1) {
            //Handle an "ondomready" callback function
            if (typeof arg === 'function') {
                var _this = this;
                _this.ready(function() {
                    arg.call(_this);
                });
            } else if (typeof arg === 'string') {
                var match = idRegExp.exec(arg);
                //Reset the search to 0 so the next call to exec will start from the beginning for the new string
                if (match != null) {
                    var widgetElId = match[1];
                    if (match[2] == null) {
                        return jquery(this.getEl(widgetElId));
                    } else {
                        return jquery('#' + this.getElId(widgetElId) + match[2]);
                    }
                } else {
                    var rootEl = this.getEl();
                    if (!rootEl) {
                        throw new Error('Root element is not defined for widget');
                    }
                    if (rootEl) {
                        return jquery(arg, rootEl);
                    }
                }
            }
        } else if (args.length === 2 && typeof args[1] === 'string') {
            return jquery(arg, this.getEl(args[1]));
        } else if (args.length === 0) {
            return jquery(this.el);
        }
        return jquery.apply(window, arguments);
    }
};

widgetProto.elId = widgetProto.getElId;

inherit(Widget, EventEmitter);

module.exports = Widget;

});
$rmod.remap("/marko-widgets@6.1.0/lib/init-widgets", "init-widgets-browser");
$rmod.def("/raptor-polyfill@1.0.2/array/_toObject", function(require, exports, module, __filename, __dirname) { var prepareString = "a"[0] != "a";

// ES5 9.9
// http://es5.github.com/#x9.9
module.exports = function (o) {
    if (o == null) { // this matches both null and undefined
        throw new TypeError("can't convert "+o+" to object");
    }
    // If the implementation doesn't support by-index access of
    // string characters (ex. IE < 9), split the string
    if (prepareString && typeof o == "string" && o) {
        return o.split("");
    }
    return Object(o);
};
});
$rmod.def("/raptor-polyfill@1.0.2/array/forEach", function(require, exports, module, __filename, __dirname) { // ES5 15.4.4.18
// http://es5.github.com/#x15.4.4.18
// https://developer.mozilla.org/en/JavaScript/Reference/Global_Objects/array/forEach

if (!Array.prototype.forEach) {
    var toObject = require('./_toObject');

    Array.prototype.forEach = function forEach(func, thisObj) {
        var self = toObject(this);
        var i = -1;
        var length = self.length >>> 0;

        // If no callback function or if callback is not a callable function
        if (typeof func !== 'function') {
            throw new TypeError();
        }

        while (++i < length) {
            if (i in self) {
                // Invoke the callback function with call, passing arguments:
                // context, property value, property key, thisArg object context
                func.call(thisObj, self[i], i, self);
            }
        }
    };
}
});
$rmod.def("/raptor-polyfill@1.0.2/string/endsWith", function(require, exports, module, __filename, __dirname) { if (!String.prototype.endsWith) {
    String.prototype.endsWith = function(suffix, position) {
        var str = this;
        
        if (position) {
            str = str.substring(position);
        }
        
        if (str.length < suffix.length) {
            return false;
        }
        
        return str.slice(0 - suffix.length) == suffix;
    };
}
});
$rmod.def("/marko-widgets@6.1.0/lib/init-widgets-browser", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

require('/$/raptor-polyfill/array/forEach'/*'raptor-polyfill/array/forEach'*/);
require('/$/raptor-polyfill/string/endsWith'/*'raptor-polyfill/string/endsWith'*/);

var logger = require('/$/raptor-logging'/*'raptor-logging'*/).logger(module);
var raptorPubsub = require('/$/raptor-pubsub'/*'raptor-pubsub'*/);
var ready = require('/$/raptor-dom'/*'raptor-dom'*/).ready;
var _addEventListener = require('./addEventListener');
var registry = require('./registry');

function invokeWidgetEventHandler(widget, targetMethodName, args) {
    var method = widget[targetMethodName];
    if (!method) {
        throw new Error('Widget ' + widget.id + ' does not have method named "' + targetMethodName + '"');
    }

    method.apply(widget, args);
}

function addDOMEventListener(widget, el, eventType, targetMethodName) {
    return _addEventListener(el, eventType, function(event) {
        invokeWidgetEventHandler(widget, targetMethodName, [event, el]);
    });
}

function parseJSON(config) {
    return eval('(' + config + ')');
}

function getNestedEl(widget, nestedId, document) {
    if (nestedId == null) {
        return null;

    }
    if (nestedId === '') {
        return widget.getEl();
    }

    if (typeof nestedId === 'string' && nestedId.charAt(0) === '#') {
        return document.getElementById(nestedId.substring(1));
    } else {
        return widget.getEl(nestedId);
    }
}

function initWidget(
    type,
    id,
    config,
    state,
    scope,
    domEvents,
    customEvents,
    extendList,
    bodyElId,
    existingWidget,
    el,
    document) {

    var i;
    var len;
    var eventType;
    var targetMethodName;
    var widget;

    if (!el) {
        el = document.getElementById(id);
    }

    if (!existingWidget) {
        existingWidget = el.__widget;
    }

    if (existingWidget && existingWidget.__type !== type) {
        existingWidget = null;
    }

    if (existingWidget) {
        existingWidget._removeDOMEventListeners();
        existingWidget._reset();
        widget = existingWidget;
    } else {
        widget = registry.createWidget(type, id, document);
    }

    if (state) {
        for (var k in state) {
            if (state.hasOwnProperty(k)) {
                var v = state[k];
                if (typeof v === 'function' || v == null) {
                    delete state[k];
                }
            }
        }
    }

    widget.state = state || {}; // First time rendering so use the provided state or an empty state object

    // The user-provided constructor function
    if (logger.isDebugEnabled()) {
        logger.debug('Creating widget: ' + type + ' (' + id + ')');
    }

    if (!config) {
        config = {};
    }

    el.__widget = widget;

    if (widget._isWidget) {
        widget.el = el;
        widget.bodyEl = getNestedEl(widget, bodyElId, document);

        if (domEvents) {
            var eventListenerHandles = [];

            for (i=0, len=domEvents.length; i<len; i+=3) {
                eventType = domEvents[i];
                targetMethodName = domEvents[i+1];
                var eventElId = domEvents[i+2];
                var eventEl = getNestedEl(widget, eventElId, document);

                // The event mapping is for a DOM event (not a custom event)
                var eventListenerHandle = addDOMEventListener(widget, eventEl, eventType, targetMethodName);
                eventListenerHandles.push(eventListenerHandle);
            }

            if (eventListenerHandles.length) {
                widget.__evHandles = eventListenerHandles;
            }
        }

        if (customEvents) {
            widget.__customEvents = {};
            widget.__scope = scope;

            for (i=0, len=customEvents.length; i<len; i+=2) {
                eventType = customEvents[i];
                targetMethodName = customEvents[i+1];
                widget.__customEvents[eventType] = targetMethodName;
            }
        }

        if (extendList) {
            // If one or more "w-extend" attributes were used for this
            // widget then call those modules to now extend the widget
            // that we created
            for (i=0, len=extendList.length; i<len; i++) {
                var extendType = extendList[i];

                if (!existingWidget) {
                    // Only extend a widget the first time the widget is created. If we are updating
                    // an existing widget then we don't re-extend it
                    var extendModule = registry.load(extendType);
                    var extendFunc = extendModule.extendWidget || extendModule.extend;

                    if (typeof extendFunc !== 'function') {
                        throw new Error('extendWidget(widget, cfg) method missing: ' + extendType);
                    }

                    extendFunc(widget);
                }
            }
        }
    } else {
        config.elId = id;
        config.el = el;
    }

    if (existingWidget) {
        widget._emitLifecycleEvent('update');
        widget._emitLifecycleEvent('render', {});
    } else {
        var initEventArgs = {
            widget: widget,
            config: config
        };

        raptorPubsub.emit('marko-widgets/initWidget', initEventArgs);

        widget._emitLifecycleEvent('beforeInit', initEventArgs);
        widget.initWidget(config);
        widget._emitLifecycleEvent('afterInit', initEventArgs);

        widget._emitLifecycleEvent('render', { firstRender: true });
    }

    return widget;
}

function initWidgetFromEl(el) {
    if (el.__widget != null) {
        // A widget is already bound to this element. Nothing to do...
        return;
    }

    var document = el.ownerDocument;
    var scope;
    var id = el.id;
    var type = el.getAttribute('data-widget');
    el.removeAttribute('data-widget');

    var config = el.getAttribute('data-w-config');
    if (config) {
        config = parseJSON(config);
        el.removeAttribute('data-w-config');
    }

    var state = el.getAttribute('data-w-state');
    if (state) {
        state = parseJSON(state);
        el.removeAttribute('data-w-state');
    }

    var domEvents;
    var hasDomEvents = el.getAttribute('data-w-on');
    if (hasDomEvents) {
        var domEventsEl = document.getElementById(id + '-$on');
        if (domEventsEl) {
            domEventsEl.parentNode.removeChild(domEventsEl);
            domEvents = (domEventsEl.getAttribute('data-on') || '').split(',');
        }

        el.removeAttribute('data-w-on');
    }

    var customEvents = el.getAttribute('data-w-events');
    if (customEvents) {
        customEvents = customEvents.split(',');
        scope = customEvents[0];
        customEvents = customEvents.slice(1);
        el.removeAttribute('data-w-events');
    }

    var extendList = el.getAttribute('data-w-extend');
    if (extendList) {
        extendList = extendList.split(',');
        el.removeAttribute('data-w-extend');
    }

    var bodyElId = el.getAttribute('data-w-body');

    initWidget(
        type,
        id,
        config,
        state,
        scope,
        domEvents,
        customEvents,
        extendList,
        bodyElId,
        null,
        el,
        document);
}


// Create a helper function handle recursion
function initClientRendered(widgetDefs, document) {
    document = document || window.document;
    for (var i=0,len=widgetDefs.length; i<len; i++) {
        var widgetDef = widgetDefs[i];

        if (widgetDef.children.length) {
            initClientRendered(widgetDef.children, document);
        }

        var widget = initWidget(
            widgetDef.type,
            widgetDef.id,
            widgetDef.config,
            widgetDef.state,
            widgetDef.scope,
            widgetDef.domEvents,
            widgetDef.customEvents,
            widgetDef.extend,
            widgetDef.bodyElId,
            widgetDef.existingWidget,
            null,
            document);

        widgetDef.widget = widget;
    }
}

/**
 * This method is used to initialized widgets associated with UI components
 * rendered in the browser. While rendering UI components a "widgets context"
 * is added to the rendering context to keep up with which widgets are rendered.
 * When ready, the widgets can then be initialized by walking the widget tree
 * in the widgets context (nested widgets are initialized before ancestor widgets).
 * @param  {Array<marko-widgets/lib/WidgetDef>} widgetDefs An array of WidgetDef instances
 */
exports.initClientRendered = initClientRendered;

/**
 * This method initializes all widgets that were rendered on the server.
 * Widgets rendered on the server are not initialized until the "document ready"
 * event is fired. Nested widgets are initialized before their parents.
 */
exports.initServerRendered = function(dataIds) {
    function doInit() {
        if (typeof dataIds !== 'string') {
            var idsEl = document.getElementById('markoWidgets');
            if (!idsEl) { // If there is no index then do nothing
                return;
            }

            // Make sure widgets are only initialized once by checking a flag
            if (document.markoWidgetsInitialized === true) {
                return;
            }

            // Set flag to avoid trying to do this multiple times
            document.markoWidgetsInitialized = true;

            dataIds = idsEl ? idsEl.getAttribute('data-ids') : null;
        }

        if (dataIds) {
            // W have a comma-separated of widget element IDs that need to be initialized
            var ids = dataIds.split(',');
            var len = ids.length;
            for (var i=0; i<len; i++) {
                var id = ids[i];
                var el = document.getElementById(id);
                if (!el) {
                    logger.error('DOM node for widget with ID "' + id + '" not found');
                    continue;
                }
                initWidgetFromEl(el);
            }
        }
    }

    if (typeof dataIds === 'string') {
        doInit();
    } else {
        ready(doInit);
    }
};
});
$rmod.def("/marko-widgets@6.1.0/lib/addEventListener", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * This module provides a cross-browser solution for adding event listeners
 * to DOM elements. This code is used to handle the differences between
 * IE and standards browsers. Older IE browsers use "attachEvent" while
 * newer browsers using "addEventListener".
 */
var testEl = document.body || document.createElement('div');

function IEListenerHandle(el, eventType, listener) {
    this._info = [el, eventType, listener];
}

IEListenerHandle.prototype = {
    remove: function() {
        var info = this._info;
        var el = info[0];
        var eventType = info[1];
        var listener = info[2];
        el.detachEvent(eventType, listener);
    }
};


function ListenerHandle(el, eventType, listener) {
    this._info = [el, eventType, listener];
}

ListenerHandle.prototype = {
    remove: function() {
        var info = this._info;
        var el = info[0];
        var eventType = info[1];
        var listener = info[2];
        el.removeEventListener(eventType, listener);
    }
};

/**
 * Adapt an native IE event to a new event by monkey patching it
 */
function getIEEvent() {
    var event = window.event;
    // add event.target
    event.target = event.target || event.srcElement;

    event.preventDefault = event.preventDefault || function() {
        event.returnValue = false;
    };

    event.stopPropagation = event.stopPropagation || function() {
        event.cancelBubble = true;
    };

	event.key = (event.which + 1 || event.keyCode + 1) - 1 || 0;

    return event;
}

if (!testEl.addEventListener) {
    // IE8...
    module.exports = function(el, eventType, listener) {
        function wrappedListener() {
            var event = getIEEvent();
            listener(event);
        }

        eventType = 'on' + eventType;

        el.attachEvent(eventType, wrappedListener);
        return new IEListenerHandle(el, eventType, wrappedListener);
    };
} else {
    // Non-IE8...
    module.exports = function(el, eventType, listener) {
        el.addEventListener(eventType, listener, false);
        return new ListenerHandle(el, eventType, listener);
    };
}

});
$rmod.main("/raptor-renderer@1.4.4", "lib/raptor-renderer");
$rmod.dep("", "raptor-renderer", "1.4.4");
$rmod.remap("/raptor-renderer@1.4.4/lib/RenderResult", "RenderResult-browser");
$rmod.def("/raptor-renderer@1.4.4/lib/RenderResult-browser", function(require, exports, module, __filename, __dirname) { 'use strict';
var dom = require('/$/raptor-dom'/*'raptor-dom'*/);
var raptorPubsub = require('/$/raptor-pubsub'/*'raptor-pubsub'*/);

function checkAddedToDOM(renderResult, method) {
    if (!renderResult._added) {
        throw new Error('Cannot call ' + method + '() until after HTML fragment is added to DOM.');
    }
}

function RenderResult(html, out) {
    this.html = html;
    this.out = out;
    this._node = undefined;

    var widgetsContext = out.global.widgets;
    this._widgetDefs = widgetsContext ? widgetsContext.widgets : null;
}

RenderResult.prototype = {
    getWidget: function () {
        checkAddedToDOM(this, 'getWidget');

        var rerenderWidget = this.out.__rerenderWidget;
        if (rerenderWidget) {
            return rerenderWidget;
        }

        var widgetDefs = this._widgetDefs;
        if (!widgetDefs) {
            throw new Error('No widget rendered');
        }
        return widgetDefs.length ? widgetDefs[0].widget : undefined;
    },
    getWidgets: function (selector) {
        checkAddedToDOM(this, 'getWidgets');

        var widgetDefs = this._widgetDefs;

        if (!widgetDefs) {
            throw new Error('No widget rendered');
        }

        var widgets;
        var i;
        if (selector) {
            // use the selector to find the widgets that the caller wants
            widgets = [];
            for (i = 0; i < widgetDefs.length; i++) {
                var widget = widgetDefs[i].widget;
                if (selector(widget)) {
                    widgets.push(widget);
                }
            }
        } else {
            // return all widgets
            widgets = new Array(widgetDefs.length);
            for (i = 0; i < widgetDefs.length; i++) {
                widgets[i] = widgetDefs[i].widget;
            }
        }
        return widgets;
    },
    afterInsert: function (document) {
        var node = this.getNode(document);

        this._added = true;
        raptorPubsub.emit('raptor-renderer/renderedToDOM', {
            node: node,
            context: this.out,
            out: this.out,
            document: node.ownerDocument
        });    // NOTE: This will trigger widgets to be initialized if there were any

        return this;
    },
    appendTo: function (referenceEl) {
        dom.appendTo(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    replace: function (referenceEl) {
        dom.replace(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    replaceChildrenOf: function (referenceEl) {
        dom.replaceChildrenOf(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    insertBefore: function (referenceEl) {
        dom.insertBefore(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    insertAfter: function (referenceEl) {
        dom.insertAfter(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    prependTo: function (referenceEl) {
        dom.prependTo(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    getNode: function (document) {
        var node = this._node;
        var curEl;
        var newBodyEl;
        document = document || window.document;
        if (node === undefined) {
            if (this.html) {
                newBodyEl = document.createElement('body');
                newBodyEl.innerHTML = this.html;
                if (newBodyEl.childNodes.length == 1) {
                    // If the rendered component resulted in a single node then just use that node
                    node = newBodyEl.childNodes[0];
                } else {
                    // Otherwise, wrap the nodes in a document fragment node
                    node = document.createDocumentFragment();
                    while ((curEl = newBodyEl.firstChild)) {
                        node.appendChild(curEl);
                    }
                }
            } else {
                // empty HTML so use empty document fragment (so that we're returning a valid DOM node)
                node = document.createDocumentFragment();
            }
            this._node = node;
        }
        return node;
    },
    toString: function() {
        return this.html;
    }
};
module.exports = RenderResult;
});
$rmod.def("/raptor-renderer@1.4.4/lib/raptor-renderer", function(require, exports, module, __filename, __dirname) { 'use strict';var process=require("process"); 
var asyncWriter = require('/$/async-writer'/*'async-writer'*/);
var RenderResult = require('./RenderResult');
var extend = require('/$/raptor-util/extend'/*'raptor-util/extend'*/);

 function createRenderFunc(renderer) {
    return function render(input, out, callback) {
        // NOTE: we avoid using Function.apply for performance reasons
        switch (arguments.length) {
            case 0:
                // Arguments: input
                return exports.render(renderer);
            case 1:
                // Arguments: input
                return exports.render(renderer, input);
            case 2:
                // Arguments: input, out|callback
                return exports.render(renderer, input, out);
            case 3:
                // Arguments: input, out, callback
                return exports.render(renderer, input, out, callback);
            default:
                throw new Error('Illegal arguments');
        }
    };
}

exports.render = function (renderer, input, out) {
    var numArgs = arguments.length;
    // The renderer function is required so only set the callback if we have more
    // than one argument
    var callback;
    if (numArgs > 1) {
        callback = arguments[numArgs - 1];
    }

    var actualOut = out;
    var actualData = input || {};

    if (typeof callback === 'function') {
        // found a callback
        if (numArgs === 3) {
            actualOut = asyncWriter.create();
        }
    } else {
        callback = null;
        if (!actualOut) {
            actualOut = asyncWriter.create();
        }
    }

    var $global = actualData.$global;
    if ($global) {
        extend(actualOut.global, $global);
        delete actualData.$global;
    }

    if (typeof renderer !== 'function') {
        var renderFunc = renderer.renderer || renderer.render || renderer.process;

        if (typeof renderFunc !== 'function') {
            throw new Error('Invalid renderer');
        }

        renderFunc.call(renderer, actualData, actualOut);
    } else {
        renderer(actualData, actualOut);
    }

    if (callback) {
        actualOut
            .on('finish', function() {
                callback(null, new RenderResult(actualOut.getOutput(), actualOut));
            })
            .on('error', callback);
        actualOut.end();
    } else {
        // NOTE: If no callback is provided then it is assumed that no asynchronous rendering occurred.
        //       Might want to add some checks in the future to ensure the actualOut is really done
        actualOut.end();
        return new RenderResult(actualOut.getOutput(), actualOut);
    }
};

exports.renderable = function(target, renderer) {
    target.renderer = renderer;
    target.render = createRenderFunc(renderer);
};

exports.createRenderFunc = createRenderFunc;

});
$rmod.def("/marko-widgets@6.1.0/lib/update-manager", function(require, exports, module, __filename, __dirname) { var process=require("process"); /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var AsyncValue = require('/$/raptor-async/AsyncValue'/*'raptor-async/AsyncValue'*/);

var afterUpdateAsyncValue = null;
var afterUpdateAsyncValue = null;
var updatesScheduled = false;

var batchStack = []; // A stack of batched updates
var unbatchedQueue = []; // Used for scheduled batched updates

/**
 * This function is called when we schedule the update of "unbatched"
 * updates to widgets.
 */
function updateUnbatchedWidgets() {
    if (!unbatchedQueue.length) {
        // No widgets to update
        return;
    }

    try {
        updateWidgets(unbatchedQueue);
    } finally {
        // Reset the flag now that this scheduled batch update
        // is complete so that we can later schedule another
        // batched update if needed
        updatesScheduled = false;
    }
}

function scheduleUpdates() {
    if (updatesScheduled) {
        // We have already scheduled a batched update for the
        // process.nextTick so nothing to do
        return;
    }

    updatesScheduled = true;

    process.nextTick(updateUnbatchedWidgets);
}

function onAfterUpdate(callback) {
    scheduleUpdates();

    if (!afterUpdateAsyncValue) {
        afterUpdateAsyncValue = new AsyncValue();
    }

    afterUpdateAsyncValue.done(callback);
}

function updateWidgets(queue) {
    // Loop over the widgets in the queue and update them.
    // NOTE: Is it okay if the queue grows during the iteration
    //       since we will still get to them at the end
    for (var i=0; i<queue.length; i++) {
        var widget = queue[i];
        widget.__updateQueued = false; // Reset the "__updateQueued" flag
        widget.update(); // Do the actual widget update
    }

    // Clear out the queue by setting the length to zero
    queue.length = 0;
}

function batchUpdate(func) {
    // If the batched update stack is empty then this
    // is the outer batched update. After the outer
    // batched update completes we invoke the "afterUpdate"
    // event listeners.
    var isOuter = batchStack.length === 0;

    var batch = {
        queue: null
    };

    batchStack.push(batch);

    try {
        func();
    } finally {
        try {
            // Update all of the widgets that where queued up
            // in this batch (if any)
            if (batch.queue) {
                updateWidgets(batch.queue);
            }
        } finally {
            // Now that we have completed the update of all the widgets
            // in this batch we need to remove it off the top of the stack
            batchStack.length--;

            if (isOuter) {
                // If there were any listeners for the "afterUpdate" event
                // then notify those listeners now
                if (afterUpdateAsyncValue) {
                    afterUpdateAsyncValue.resolve();
                    afterUpdateAsyncValue = null;
                }
            }
        }
    }
}

function queueWidgetUpdate(widget) {
    if (widget.__updateQueued) {
        // The widget has already been queued up for an update. Once
        // the widget has actually been updated we will reset the
        // "__updateQueued" flag so that it can be queued up again.
        // Since the widget has already been queued up there is nothing
        // that needs to be done.
        return;
    }

    widget.__updateQueued = true;

    var batchStackLen = batchStack.length;

    if (batchStackLen) {
        // When a batch update is started we push a new batch on to a stack.
        // If the stack has a non-zero length then we know that a batch has
        // been started so we can just queue the widget on the top batch. When
        // the batch is ended this widget will be updated.
        var batch = batchStack[batchStackLen-1];

        // We default the batch queue to null to avoid creating an Array instance
        // unnecessarily. If it is null then we create a new Array, otherwise
        // we push it onto the existing Array queue
        if (batch.queue) {
            batch.queue.push(widget);
        } else {
            batch.queue = [widget];
        }
    } else {
        // We are not within a batched update. We need to schedule a batch update
        // for the process.nextTick (if that hasn't been done already) and we will
        // add the widget to the unbatched queued
        scheduleUpdates();
        unbatchedQueue.push(widget);
    }
}

exports.queueWidgetUpdate = queueWidgetUpdate;
exports.batchUpdate = batchUpdate;
exports.onAfterUpdate = onAfterUpdate;
});
$rmod.def("/marko-widgets@6.1.0/lib/repeated-id", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

function RepeatedId() {
    this.nextIdLookup = {};
}

RepeatedId.prototype = {
    nextId: function(parentId, id) {
        var indexLookupKey = parentId + '-' + id;
        var currentIndex = this.nextIdLookup[indexLookupKey];
        if (currentIndex == null) {
            currentIndex = this.nextIdLookup[indexLookupKey] = 0;
        } else {
            currentIndex = ++this.nextIdLookup[indexLookupKey];
        }

        return indexLookupKey.slice(0, -2) + '[' + currentIndex + ']';
    }
};

exports.nextId = function(out, parentId, id) {
    var repeatedId = out.global.__repeatedId;
    if (repeatedId == null) {
        repeatedId = out.global.__repeatedId = new RepeatedId();
    }

    return repeatedId.nextId(parentId, id);
};

});
$rmod.def("/marko-widgets@6.1.0/lib/WidgetDef", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

require('/$/raptor-polyfill/string/endsWith'/*'raptor-polyfill/string/endsWith'*/);

var repeatedId = require('../lib/repeated-id');

/**
 * A WidgetDef is used to hold the metadata collected at runtime for
 * a single widget and this information is used to instantiate the widget
 * later (after the rendered HTML has been added to the DOM)
 */
function WidgetDef(config, endFunc, out) {
    this.type = config.type; // The widget module type name that is passed to the factory
    this.id = config.id; // The unique ID of the widget
    this.config = config.config; // Widget config object (may be null)
    this.state = config.state; // Widget state object (may be null)
    this.scope = config.scope; // The ID of the widget that this widget is scoped within
    this.domEvents = null; // An array of DOM events that need to be added (in sets of three)
    this.customEvents = config.customEvents; // An array containing information about custom events
    this.bodyElId = config.bodyElId; // The ID for the default body element (if any any)
    this.children = []; // An array of nested WidgetDef instances
    this.end = endFunc; // A function that when called will pop this widget def off the stack
    this.extend = config.extend; // Information about other widgets that extend this widget.
    this.out = out; // The AsyncWriter that this widget is associated with
    this.hasDomEvents = config.hasDomEvents; // A flag to indicate if this widget has any
                                             // listeners for non-bubbling DOM events
    this._nextId = 0; // The unique integer to use for the next scoped ID
}

WidgetDef.prototype = {
    /**
     * Register a nested widget for this widget. We maintain a tree of widgets
     * so that we can instantiate nested widgets before their parents.
     */
    addChild: function (widgetDef) {
        this.children.push(widgetDef);
    },
    /**
     * This helper method generates a unique and fully qualified DOM element ID
     * that is unique within the scope of the current widget. This method prefixes
     * the the nestedId with the ID of the current widget. If nestedId ends
     * with `[]` then it is treated as a repeated ID and we will generate
     * an ID with the current index for the current nestedId.
     * (e.g. "myParentId-foo[0]", "myParentId-foo[1]", etc.)
     */
    elId: function (nestedId) {
        if (nestedId == null) {
            return this.id;
        } else {
            if (typeof nestedId === 'string' && nestedId.endsWith('[]')) {
                return repeatedId.nextId(this.out, this.id, nestedId);
            } else {
                return this.id + '-' + nestedId;
            }
        }
    },
    /**
     * Registers a DOM event for a nested HTML element associated with the
     * widget. This is only done for non-bubbling events that require
     * direct event listeners to be added.
     * @param  {String} type The DOM event type ("mouseover", "mousemove", etc.)
     * @param  {String} targetMethod The name of the method to invoke on the scoped widget
     * @param  {String} elId The DOM element ID of the DOM element that the event listener needs to be added too
     */
    addDomEvent: function(type, targetMethod, elId) {
        if (!this.domEvents) {
            this.domEvents = [];
        }
        this.domEvents.push(type);
        this.domEvents.push(targetMethod);
        this.domEvents.push(elId);
    },
    /**
     * Returns a string representation of the DOM events data.
     */
    getDomEventsAttr: function() {
        if (this.domEvents) {
            return this.domEvents.join(',');
        }
    },
    /**
     * Returns the next auto generated unique ID for a nested DOM element or nested DOM widget
     */
    nextId: function() {
        return this.id + '-w' + (this._nextId++);
    }
};

module.exports = WidgetDef;
});
$rmod.remap("/marko-widgets@6.1.0/lib/uniqueId", "uniqueId-browser");
$rmod.def("/marko-widgets@6.1.0/lib/uniqueId-browser", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var uniqueId = window.MARKO_WIDGETS_UNIQUE_ID;
if (!uniqueId) {
    var _nextUniqueId = 0;
    window.MARKO_WIDGETS_UNIQUE_ID = uniqueId = function() {
        return 'wc' + (_nextUniqueId++);
    };
}

module.exports = uniqueId;
});
$rmod.def("/marko-widgets@6.1.0/lib/WidgetsContext", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var WidgetDef = require('./WidgetDef');
var uniqueId = require('./uniqueId');
var initWidgets = require('./init-widgets');
var EventEmitter = require('/$/events'/*'events'*/).EventEmitter;
var inherit = require('/$/raptor-util/inherit'/*'raptor-util/inherit'*/);

var PRESERVE_EL = 1;
var PRESERVE_EL_BODY = 2;
var PRESERVE_EL_UNPRESERVED_BODY = 4;

function WidgetsContext(out) {
    EventEmitter.call(this);
    this.out = out;
    this.widgets = [];
    this.widgetStack = [];
    this.preserved = null;
    this.reusableWidgets = null;
    this.reusableWidgetsById = null;
    this.widgetsById = {};
}

WidgetsContext.prototype = {
    getWidgets: function () {
        return this.widgets;
    },

    getWidgetStack: function() {
        return this.widgetStack;
    },

    getCurrentWidget: function() {
        return this.widgetStack.length ? this.widgetStack[this.widgetStack.length - 1] : undefined;
    },

    beginWidget: function (widgetInfo, callback) {
        var _this = this;
        var widgetStack = _this.widgetStack;
        var origLength = widgetStack.length;
        var parent = origLength ? widgetStack[origLength - 1] : null;

        if (!widgetInfo.id) {
            widgetInfo.id = _this._nextWidgetId();
        }

        widgetInfo.parent = parent;

        function end() {
            widgetStack.length = origLength;
        }

        var widgetDef = new WidgetDef(widgetInfo, end, this.out);
        this.widgetsById[widgetInfo.id] = widgetDef;

        if (parent) {
            //Check if it is a top-level widget
            parent.addChild(widgetDef);
        } else {
            _this.widgets.push(widgetDef);
        }
        widgetStack.push(widgetDef);

        this.emit('beginWidget', widgetDef);

        return widgetDef;
    },
    getWidget: function(id) {
        return this.widgetsById[id];
    },
    hasWidgets: function () {
        return this.widgets.length !== 0;
    },
    clearWidgets: function () {
        this.widgets = [];
        this.widgetStack = [];
    },
    _nextWidgetId: function () {
        return uniqueId(this.out);
    },
    initWidgets: function (document) {
        var widgetDefs = this.widgets;
        initWidgets.initClientRendered(widgetDefs, document);
        this.clearWidgets();
    },
    onBeginWidget: function(listener) {
        this.on('beginWidget', listener);
    },

    isPreservedEl: function(id) {
        var preserved = this.preserved;
        return preserved && (preserved[id] & PRESERVE_EL);
    },

    isPreservedBodyEl: function(id) {
        var preserved = this.preserved;
        return preserved && (preserved[id] & PRESERVE_EL_BODY);
    },

    hasUnpreservedBody: function(id) {
        var preserved = this.preserved;
        return preserved && (preserved[id] & PRESERVE_EL_UNPRESERVED_BODY);
    },

    addPreservedDOMNode: function(existingEl, bodyOnly, hasUnppreservedBody) {
        var preserved = this.preserved || (this.preserved = {});

        var value = bodyOnly ?
            PRESERVE_EL_BODY :
            PRESERVE_EL;

        if (hasUnppreservedBody) {
            value |= PRESERVE_EL_UNPRESERVED_BODY;
        }

        preserved[existingEl.id] = value;
    }
};

inherit(WidgetsContext, EventEmitter);

WidgetsContext.getWidgetsContext = function (out) {
    var global = out.global;

    return out.data.widgets ||
        global.widgets ||
        (global.widgets = new WidgetsContext(out));
};


module.exports = WidgetsContext;
});
$rmod.def("/marko-widgets@6.1.0/lib/bubble", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
module.exports = [
    /* Mouse Events */
    'click',
    'dblclick',
    'mousedown',
    'mouseup',
    // 'mouseover',
    // 'mousemove',
    // 'mouseout',
    'dragstart',
    'drag',
    // 'dragenter',
    // 'dragleave',
    // 'dragover',
    'drop',
    'dragend',

    /* Keyboard Events */
    'keydown',
    'keypress',
    'keyup',

    /* Form Events */
    'select',
    'change',
    'submit',
    'reset'
    // 'focus', <-- Does not bubble
    // 'blur', <-- Does not bubble
    // 'focusin', <-- Not supported in all browsers
    // 'focusout' <-- Not supported in all browsers
];
});
$rmod.def("/marko-widgets@6.1.0/lib/registry", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var registered = {};
var loaded = {};
var widgetTypes = {};
var defineWidget;
var defineRenderer;

exports.register = function(typeName, type) {
    if (arguments.length === 1) {
        var widgetType = arguments[0];
        typeName = widgetType.name;
        type = widgetType.def();
    }
    registered[typeName] = type;
    delete loaded[typeName];
    delete widgetTypes[typeName];
};

function load(typeName) {
    var target = loaded[typeName];
    if (target === undefined) {
        target = registered[typeName];
        if (!target) {
            target = require(typeName); // Assume the typeName has been fully resolved already
        }
        loaded[typeName] = target || null;
    }

    if (target == null) {
        throw new Error('Unable to load: ' + typeName);
    }
    return target;
}

function getWidgetClass(typeName) {
    var WidgetClass = widgetTypes[typeName];

    if (WidgetClass) {
        return WidgetClass;
    }

    WidgetClass = load(typeName);

    var renderer;


    if (WidgetClass.Widget) {
        WidgetClass = WidgetClass.Widget;
    }

    if (WidgetClass.renderer) {
        renderer = defineRenderer(WidgetClass);
    }

    WidgetClass = defineWidget(WidgetClass, renderer);

    // Make the widget "type" accessible on each widget instance
    WidgetClass.prototype.__type = typeName;

    widgetTypes[typeName] = WidgetClass;

    return WidgetClass;
}

exports.load = load;

exports.createWidget = function(typeName, id, document) {
    var WidgetClass = getWidgetClass(typeName);
    var widget;
    if (typeof WidgetClass === 'function') {
        // The widget is a constructor function that we can invoke to create a new instance of the widget
        widget = new WidgetClass(id, document);
    } else if (WidgetClass.initWidget) {
        widget = WidgetClass;
        widget.__document = document;
    }
    return widget;
};

defineWidget = require('./defineWidget');
defineRenderer = require('./defineRenderer');
});
$rmod.def("/marko-widgets@6.1.0/lib/defineComponent", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Define a new UI component that includes widget and renderer.
 *
 * @param  {Object} def The definition of the UI component (widget methods, widget constructor, rendering methods, etc.)
 * @return {Widget} The resulting Widget with renderer
 */
var defineRenderer;
var defineWidget;

module.exports = function defineComponent(def) {
    if (def._isWidget) {
        return def;
    }

    var renderer;

    if (def.template || def.renderer) {
        renderer = defineRenderer(def);
    } else {
        throw new Error('Expected "template" or "renderer"');
    }

    return defineWidget(def, renderer);
};

defineRenderer = require('./defineRenderer');
defineWidget = require('./defineWidget');


});
$rmod.remap("/marko-widgets@6.1.0/lib/defineWidget", "defineWidget-browser");
$rmod.def("/marko-widgets@6.1.0/lib/defineWidget-browser", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
 var BaseWidget;
 var inherit;

module.exports = function defineWidget(def, renderer) {
    if (def._isWidget) {
        return def;
    }

    var extendWidget = def.extendWidget;
    if (extendWidget) {
        return {
            renderer: renderer,
            render: renderer.render,
            extendWidget: function(widget) {
                extendWidget(widget);
                widget.renderer = renderer;
            }
        };
    }

    var WidgetClass;
    var proto;

    if (typeof def === 'function') {
        WidgetClass = def;
        proto = WidgetClass.prototype;

        if (proto.render && proto.render.length === 2) {
            throw new Error('"render(input, out)" is no longer supported. Use "renderer(input, out)" instead.');
        }
    } else if (typeof def === 'object') {
        WidgetClass = def.init || function() {};
        proto = WidgetClass.prototype = def;
    } else {
        throw new Error('Invalid widget');
    }

    // We don't use the constructor provided by the user
    // since we don't invoke their constructor until
    // we have had a chance to do our own initialization.
    // Instead, we store their constructor in the "initWidget"
    // property and that method gets called later inside
    // init-widgets-browser.js
    function Widget(id, document) {
        BaseWidget.call(this, id, document);
    }

    if (!proto._isWidget) {
        // Inherit from Widget if they didn't already
        inherit(WidgetClass, BaseWidget);
    }

    // The same prototype will be used by our constructor after
    // we he have set up the prototype chain using the inherit function
    proto = Widget.prototype = WidgetClass.prototype;

    proto.initWidget = WidgetClass;

    proto.constructor = def.constructor = Widget;

    // Set a flag on the constructor function to make it clear this is
    // a widget so that we can short-circuit this work later
    Widget._isWidget = true;

    if (renderer) {
        // Add the rendering related methods as statics on the
        // new widget constructor function
        Widget.renderer = proto.renderer = renderer;
        Widget.render = renderer.render;
    }

    return Widget;
};

BaseWidget = require('./Widget');
inherit = require('/$/raptor-util/inherit'/*'raptor-util/inherit'*/);


});
$rmod.def("/marko-widgets@6.1.0/lib/defineRenderer", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var marko = require('/$/marko'/*'marko'*/);
var raptorRenderer = require('/$/raptor-renderer'/*'raptor-renderer'*/);
var extend = require('/$/raptor-util/extend'/*'raptor-util/extend'*/);

module.exports = function defineRenderer(def) {
    var template = def.template;
    var getInitialProps = def.getInitialProps;
    var getTemplateData = def.getTemplateData;
    var getInitialState = def.getInitialState;
    var getWidgetConfig = def.getWidgetConfig;
    var getInitialBody = def.getInitialBody;
    var extendWidget = def.extendWidget;
    var renderer = def.renderer;

    var loadedTemplate;


    if (!renderer) {
        // Create a renderer function that takes care of translating
        // the input properties to a view state. Also, this renderer
        // takes care of re-using existing widgets.
        renderer = function renderer(input, out) {
            var global = out.global;

            var newProps = input;

            if (!newProps) {
                // Make sure we always have a non-null input object
                newProps = {};
            }

            if (!loadedTemplate) {
                // Lazily load the template on first render to avoid potential problems
                // with circular dependencies
                loadedTemplate = template.render ? template : marko.load(template);
            }

            var widgetState;

            if (getInitialState) {
                // This is a state-ful widget. If this is a rerender then the "input"
                // will be the new state. If we have state then we should use the input
                // as the widget state and skip the steps of converting the input
                // to a widget state.

                if (global.__rerenderWidget && global.__rerenderState) {
                    var isFirstWidget = !global.__firstWidgetFound;

                    if (!isFirstWidget || extendWidget) {
                        // We are the not first top-level widget or we are being extended
                        // so use the merged rerender state as defaults for the input
                        // and use that to rebuild the new state. This is kind of a hack
                        // but extending widgets requires this hack since there is no
                        // single state since the widget state is split between the
                        // widget being extended and the widget doing the extending.
                        for (var k in global.__rerenderState) {
                            if (global.__rerenderState.hasOwnProperty(k) && !input.hasOwnProperty(k)) {
                                newProps[k] = global.__rerenderState[k];
                            }
                        }
                    } else {
                        // We are the first widget and we are not being extended
                        // and we are not extending so use the input as the state
                        widgetState = input;
                        newProps = null;
                    }
                }
            }

            if (!widgetState) {
                // If we do not have state then we need to go through the process
                // of converting the input to a widget state, or simply normalizing
                // the input using getInitialProps

                if (getInitialProps) {
                    // This optional method is used to normalize input state
                    newProps = getInitialProps(newProps, out) || {};
                }

                if (getInitialState) {
                    // This optional method is used to derive the widget state
                    // from the input properties
                    widgetState = getInitialState(newProps, out);
                }
            }

            global.__firstWidgetFound = true;

            // Use getTemplateData(state, props, out) to get the template
            // data. If that method is not provided then just use the
            // the state (if provided) or the input data.
            var templateData = getTemplateData ?
                getTemplateData(widgetState, newProps, out) :
                widgetState || newProps;

            if (templateData) {
                // We are going to be modifying the template data so we need to
                // make a shallow clone of the object so that we don't
                // mutate user provided data.
                templateData = extend({}, templateData);
            } else {
                // We always should have some template data
                templateData = {};
            }

            if (widgetState) {
                // If we have widget state then pass it to the template
                // so that it is available to the widget tag
                templateData.widgetState = widgetState;
            }

            if (newProps) {
                // If we have widget props then pass it to the template
                // so that it is available to the widget tag. The widget props
                // are only needed so that we can call widget.shouldUpdate(newProps)
                templateData.widgetProps = newProps;

                if (getInitialBody) {
                    // If we have widget a widget body then pass it to the template
                    // so that it is available to the widget tag and can be inserted
                    // at the w-body marker
                    templateData.widgetBody = getInitialBody(newProps, out);
                } else {
                    // Default to using the nested content as the widget body
                    // getInitialBody was not implemented
                    templateData.widgetBody = newProps.renderBody;
                }

                if (getWidgetConfig) {
                    // If getWidgetConfig() was implemented then use that to
                    // get the widget config. The widget config will be passed
                    // to the widget constructor. If rendered on the server the
                    // widget config will be serialized to a JSON-like data
                    // structure and stored in a "data-w-config" attribute.
                    templateData.widgetConfig = getWidgetConfig(newProps, out);
                }
            }

            // Render the template associated with the component using the final template
            // data that we constructed
            loadedTemplate.render(templateData, out);
        };
    }

    renderer.render = raptorRenderer.createRenderFunc(renderer);

    return renderer;
};


});
$rmod.remap("/marko-widgets@6.1.0/lib/index", "index-browser");
$rmod.def("/marko-widgets@6.1.0/lib/index-browser", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var raptorPubsub = require('/$/raptor-pubsub'/*'raptor-pubsub'*/);
var ready = require('/$/raptor-dom'/*'raptor-dom'*/).ready;
var EMPTY_OBJ = {};
var Widget = require('./Widget');
var initWidgets = require('./init-widgets');
var _addEventListener = require('./addEventListener');
var raptorRenderer = require('/$/raptor-renderer'/*'raptor-renderer'*/);
var updateManager = require('./update-manager');

// Exports:
var WidgetsContext = exports.WidgetsContext = require('./WidgetsContext');
exports.getWidgetsContext = WidgetsContext.getWidgetsContext;
exports.Widget = Widget;
exports.ready = ready;
exports.onInitWidget = function(listener) {
    raptorPubsub.on('marko-widgets/initWidget', listener);
};
exports.attrs = function() {
    return EMPTY_OBJ;
};

exports.writeDomEventsEl = function() {
    /* Intentionally empty in the browser */
};

function getWidgetForEl(id, document) {
    if (!id) {
        return undefined;
    }

    var node = typeof id === 'string' ? (document || window.document).getElementById(id) : id;
    return (node && node.__widget) || undefined;
}

exports.get = exports.getWidgetForEl = getWidgetForEl;

exports.initAllWidgets = function() {
    initWidgets.initServerRendered(true /* scan DOM */);
};

// Subscribe to DOM manipulate events to handle creating and destroying widgets
raptorPubsub
    .on('dom/beforeRemove', function(eventArgs) {
        var el = eventArgs.el;
        var widget = el.id ? getWidgetForEl(el) : null;
        if (widget) {
            widget.destroy({
                removeNode: false,
                recursive: true
            });
        }
    })
    .on('raptor-renderer/renderedToDOM', function(eventArgs) {
        var out = eventArgs.out || eventArgs.context;
        var widgetsContext = out.global.widgets;
        if (widgetsContext) {
            widgetsContext.initWidgets(eventArgs.document);
        }
    });



exports.initWidgets = window.$markoWidgets = function(ids) {
    initWidgets.initServerRendered(ids);
};

var JQUERY = 'jquery';
var jquery = window.$;

if (!jquery) {
    try {
        jquery = require(JQUERY);
    }
    catch(e) {}
}

exports.$ = jquery;

ready(function() {
    var body = document.body;
    // Here's where we handle event delegation using our own mechanism
    // for delegating events. For each event that we have white-listed
    // as supporting bubble, we will attach a listener to the root
    // document.body element. When we get notified of a triggered event,
    // we again walk up the tree starting at the target associated
    // with the event to find any mappings for event. Each mapping
    // is from a DOM event type to a method of a widget.
    require('./bubble').forEach(function addBubbleHandler(eventType) {
        _addEventListener(body, eventType, function(event) {
            var propagationStopped = false;

            // Monkey-patch to fix #97
            var oldStopPropagation = event.stopPropagation;

            event.stopPropagation = function() {
                oldStopPropagation.call(event);
                propagationStopped = true;
            };

            updateManager.batchUpdate(function() {
                var curNode = event.target;
                if (!curNode) {
                    return;
                }

                // Search up the tree looking DOM events mapped to target
                // widget methods
                var attrName = 'data-w-on' + eventType;
                var targetMethod;
                var targetWidget;

                // Attributes will have the following form:
                // w-on<event_type>="<target_method>|<widget_id>"

                do {
                    if ((targetMethod = curNode.getAttribute(attrName))) {
                        var separator = targetMethod.lastIndexOf('|');
                        var targetWidgetId = targetMethod.substring(separator+1);
                        targetWidget = document.getElementById(targetWidgetId).__widget;

                        if (!targetWidget) {
                            throw new Error('Widget not found: ' + targetWidgetId);
                        }
                        targetMethod = targetMethod.substring(0, separator);

                        var targetFunc = targetWidget[targetMethod];
                        if (!targetFunc) {
                            throw new Error('Method not found on widget ' + targetWidget.id + ': ' + targetMethod);
                        }

                        // Invoke the widget method
                        targetWidget[targetMethod](event, curNode);
                        if (propagationStopped) {
                            break;
                        }
                    }
                } while((curNode = curNode.parentNode) && curNode.getAttribute);
            });
        });
    });
});

exports.registerWidget = require('./registry').register;
exports.makeRenderable = exports.renderable = raptorRenderer.renderable;
exports.render = raptorRenderer.render;
exports.defineComponent = require('./defineComponent');
exports.defineWidget = require('./defineWidget');
exports.defineRenderer = require('./defineRenderer');
exports.batchUpdate = updateManager.batchUpdate;
exports.onAfterUpdate = updateManager.onAfterUpdate;

window.$MARKO_WIDGETS = exports; // Helpful when debugging... WARNING: DO NOT USE IN REAL CODE!

});
$rmod.main("/domready@1.0.8", "ready");
$rmod.dep("", "domready", "1.0.8");
$rmod.def("/domready@1.0.8/ready", function(require, exports, module, __filename, __dirname) { /*!
  * domready (c) Dustin Diaz 2014 - License MIT
  */
!function (name, definition) {

  if (typeof module != 'undefined') module.exports = definition()
  else if (typeof define == 'function' && typeof define.amd == 'object') define(definition)
  else this[name] = definition()

}('domready', function () {

  var fns = [], listener
    , doc = document
    , hack = doc.documentElement.doScroll
    , domContentLoaded = 'DOMContentLoaded'
    , loaded = (hack ? /^loaded|^c/ : /^loaded|^i|^c/).test(doc.readyState)


  if (!loaded)
  doc.addEventListener(domContentLoaded, listener = function () {
    doc.removeEventListener(domContentLoaded, listener)
    loaded = 1
    while (listener = fns.shift()) listener()
  })

  return function (fn) {
    loaded ? setTimeout(fn, 0) : fns.push(fn)
  }

});

});