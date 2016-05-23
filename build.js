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

    console.log('Written.')
})