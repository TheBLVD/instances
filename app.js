const express = require('express');
const flash = require('express-flash-2');
const bodyParser = require('body-parser');
const nunjucks = require('nunjucks');
const fs = require('fs');
const Session = require('express-session');
const Languages = global.Languages = require('languages');
const CountryLanguages = require('country-language');
const {Op} = require("sequelize");
const MongoStore = require('connect-mongo')(Session);

global.Request = require('request').defaults({
    headers: {
        'User-Agent': 'MastodonInstances/1.0.0 (https://instances.mastodon.xyz)'
    }
});

global.config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
global.ProhibitedContent = JSON.parse(fs.readFileSync('prohibitedContent.json', 'utf8'));
ProhibitedContent.array = Object.keys(ProhibitedContent).map((code) => {
	return {
		code,
		name: ProhibitedContent[code]
	};
});

global.DB = require('monk')(config.database);
const app = express();

app.locals.ProhibitedContent = ProhibitedContent;
app.locals.Languages = Languages;
app.locals.langs = CountryLanguages.getLanguages()
    .filter((a)=>{return a.nativeName[0] !== ""})
    .sort((a,b)=>{return a.name[0].localeCompare(b.name[0])});
app.locals.langCodes = app.locals.langs.map(l => l.iso639_1);
app.locals.countries = CountryLanguages.getCountries()
    .sort((a,b)=>{return a.name[0].localeCompare(b.name[0])});

updateNetworkStats();
setInterval(updateNetworkStats, 5 * 60 * 1000);

function updateNetworkStats() {
	const Instance = require('./models/instance');

	Instance.findAll({
		where: {
			uptime_all: {
				[Op.gt]: 0
			},
			dead: false,
			blacklisted: false
		}
	}).then((instances) => {
		let users = 0,
			statuses = 0,
			connections = 0;
		let instancesCount = 0;

		for(let instance of instances) {
			instancesCount++;

			if(instance.users)
				users += instance.users;

			if(instance.statuses)
				statuses += parseInt(instance.statuses);

			if(instance.connections)
				connections += instance.connections;
		}

		global.networkStats = app.locals.networkStats = {
			users,
			statuses,
			connections,
			instances:instancesCount
		};
	}).catch(console.error);
}

app.enable('trust proxy');

const session = Session({
	cookie: {
		httpOnly: true,
		maxAge: 60 * 60 * 1000,
		secure: process.env.NODE_ENV !== 'development'
	},
	proxy: true,
	secret: config.session_secret,
	resave: false,
	saveUninitialized: false,
	store: new MongoStore({
		url: 'mongodb://' + config.database
	})
});
app.use(session);
app.use(flash());

nunjucks.configure('views', {
    express: app,
    watch: process.env.NODE_ENV === 'development'
});
app.set('view engine', 'njk');

app.use(bodyParser.urlencoded({
    extended: false
}));
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(require('./controllers'));

app.listen(8737);
