var xhr = require('xhr');
var runtime = require('marko');
var compiler = require('marko/compiler');
var domready = require('domready');
var widgets = require('marko-widgets');
var stripIndent = require('strip-indent');
var resolveUrl = require("resolve-url");
var EventEmitter = require('events').EventEmitter;
var includePattern = /<(include|layout-use)\(("[^"]+"|'[^']+'|`[^`]`)\s*(,|\))/g;

var marko = window.marko = {
    templates:{},
    defineComponent:widgets.defineComponent,
    ready:function(fn) {
        marko.events.on('ready', fn);
    },
    events: new EventEmitter(),
    load:function(path, src, fn) {
        if(src instanceof Function) {
            fn = src;
            src = undefined;
        }

        if(src == undefined) {
            marko.templates[path] = undefined;
            xhr({ url:path }, function(err, response, body) {
                if(err) {
                    if(window.location.protocol == 'file:') {
                        err = new Error('Due to security restrictions in browsers, you cannot load external templates over the file:// protocol.  You should set up a static http server like this one:  https://www.npmjs.com/package/anywhere')
                    }
                    return fn(err);
                }
                loadDependencies(path, body, fn);
            });
        } else {
            loadDependencies(path, src, fn);
        }
    }
}

function loadDependencies(path, src, fn) {
    var include;
    var dependencies = [];
    while(include = includePattern.exec(src)) {
        if(/^`.*${.*`$/.test(src)) {
            return fn(new Error('Dynamic path found for a <'+include[1]+'> tag in template: '+path));
        }
        dependencies.push(eval(include[2]));
    }

    dependencies = dependencies.filter(function needLoading(dep) {
        return !(dep in marko.templates);
    });

    if(!dependencies.length) {
        compileTemplate(path, src, fn);
    } else {
        var remaining = dependencies.length;
        var returned = false;
        dependencies.forEach(function(dep) {
            marko.load(dep, function(err) {
                if(returned) return;

                if(err) {
                    returned = true;
                    return fn(err);
                }

                if(!--remaining) {
                    compileTemplate(path, src, fn);
                }
            })
        })
    }
}

function compileTemplate(path, src, fn) {
    var compiledSrc = compiler.compile(modifySrc(src), path, null);
    var template = evalCommonJsTemplateSrc(path, compiledSrc);
    marko.templates[path] = template;
    return fn(null, template);
}

function modifySrc(src) {
    return stripIndent(src).replace(includePattern, function(match, tag, path, delimiter) {
        path = eval(path);
        return '<'+tag+'(window.marko.templates['+JSON.stringify(path)+']'+delimiter;
    });
}

function evalCommonJsTemplateSrc(path, src) {
    var wrappedSource = '(function(require, exports, module, __filename, __dirname) { ' + src + ' })';
    var factoryFunc = eval(wrappedSource);
    var templateExports = {};
    var templateModule = {
        require: require,
        exports: templateExports,
        id: name
    };

    factoryFunc(require, templateExports, templateModule, path, '/');
    return templateModule.exports;
}

domready(function() {
    var remaining = 0;
    [].filter.call(document.querySelectorAll('script[type*=marko]'), function(script) {
        var src = script.getAttribute('src');
        var name = script.getAttribute('name');

        if(!name) {
            return showError(new Error('One of your templates defined in a script tag is missing a name attribute'));
        }

        if(name in marko.templates) {
            return showError(new Error('A template with named "'+name+'" has already been registered'));
        }

        if(name) {
            marko.templates[name] = undefined;
        }

        return true;
    }).forEach(function(script) {
        var markup = script.innerHTML;
        var path = script.getAttribute('src') || script.getAttribute('name');

        remaining++;

        marko.load(path, markup, function(err) {
            if(err) return showError(err);
            if(!--remaining) {
                marko.events.emit('ready');
            }
        });
    });
});

function showError(error) {
    if(window.console) {
        console.error(error);
        return;
    }
    var errorContainer = document.createElement('div');
    errorContainer.style.fontWeight = 'bold';
    errorContainer.style.color = '#900';
    errorContainer.textContent = error.message;
    document.body.append(errorContainer);
    return;
}