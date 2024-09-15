// webpack.config.js
const path = require('path');

module.exports = {
    entry: './src/index.js', // Ingångspunkt för frontend
    output: {
        path: path.resolve(__dirname, 'public', 'dist'), // Utmatningsmapp
        filename: 'bundle.js', // Utmatningsfil
    },
    mode: 'development', // Ändra till 'production' för produktionsbyggen
    module: {
        rules: [
            {
                test: /\.js$/, // Hantera JS-filer med Babel
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                },
            },
            {
                test: /\.css$/, // Hantera CSS-filer
                use: ['style-loader', 'css-loader'],
            },
        ],
    },
    resolve: {
        extensions: ['.js'],
    },
    devtool: 'source-map', // För enklare felsökning
};
