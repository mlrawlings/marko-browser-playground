var runtime = require('marko');
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