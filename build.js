var fs = require('fs');
var lasso = require('lasso');
lasso.configure('lasso.json');
lasso.lassoPage({
    name:'marko-browser',
    dependencies:[
        'require-run: ./source.js',
        'require: marko',
        'require: marko/compiler',
        'require: marko-widgets',
        'require: domready'
    ]
}, function(err, result) {
    if(err) {
        throw err;
    }

    fs.appendFileSync('./marko-browser.js', `
        window.global = window.global || {};
        $rmod.pending().done();
    `);

    console.log('Written.')
})