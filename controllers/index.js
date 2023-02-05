const router = require('express-promise-router')();
const stripHtml = require('string-strip-html').stripHtml;
const CountryLanguages = require('country-language');
const alParser = require('accept-language-parser');
const morgan = require('../middlewares/morgan');
const pg = require('../pg');

const Sequelize = require('sequelize');
const Op = Sequelize.Op;
const Instance = require('../models/instance');
const Ping = require('../models/ping');
const Probe = require('../models/probe');

router.use('/api', require('./api'));
router.use('/admin', (req, res, next) => {
	if(req.session.user) {
		DB.get('admins').findOne({
			_id: req.session.user
		}).then((admin) => {
			req.user = res.locals.user = admin;
			next();
		}).catch((e) => {
			res.sendStatus(500);
		});
	} else {
		next();
	}
}, require('./admin'));

router.get('/', (req, res) => {
    res.render('index', {
    	acceptsLanguage: alParser.pick(req.app.locals.langCodes, req.get('Accept-Language'))
	});
});

router.get('/list.json', (req, res) => {
	let q = {
		"uptime": {
			"$gt": 0
		},
		"blacklisted": {
			"$ne": true
		},
        "dead": {
            "$ne": true
        },
        "users": {
            "$exists": true
        },
        "version": {
            "$exists": true
        },
        "infos.optOut": {
            "$ne": true
        }
	};

	let cq = req.query.q || {};
	let strict = req.query.strict === 'true';
	let infoNeeded = false;

    if(Array.isArray(cq.languages) && cq.languages.length > 0) {
        infoNeeded = true;

        if(!strict) {
            q['infos.languages'] = {
                $elemMatch: {
                    $in: cq.languages
                }
            };
        } else {
            q['infos.languages'] = {
                $all: cq.languages
            };
        }
    }

    if(strict) {
        if (Array.isArray(cq.prohibited) && cq.prohibited.length > 0) {
            infoNeeded = true;

            q['infos.prohibitedContent'] = {
                $all: cq.prohibited
            };
        }

        if (Array.isArray(cq.allowed) && cq.allowed.length > 0) {
            infoNeeded = true;

            q['infos.prohibitedContent'] = {
                $not: {
                    $elemMatch: {
                        $in: cq.allowed
                    }
                }
            };
        }

        if(cq.min_users) {
            try {
                q.users.$gte = Number.parseInt(cq.min_users);
            } catch(e) {}
        }

        if(cq.max_users) {
            try {
                q.users.$lte = Number.parseInt(cq.max_users);
            } catch(e) {}
        }
    } else {
        q["up"] = {
            "$eq": true
        };
        q["openRegistrations"] = {
            "$eq": true
        };
    }

    if(infoNeeded) {
	    q['infos'] = {
	        '$exists': true
        };
    }

    if(cq.search) {
        let r = new RegExp(cq.search);
        q.$or = [{
            name: r
        }, {
            'infos.shortDescription': r
        }, {
            'infos.fullDescription': r
        }, {
            'infos.theme': r
        }, {
            'infos.categories': {
                $elemMatch: {
                    $regex: r
                }
            }
        }];
    }

    DB.get('instances').find(q).then((instances) => {
		instances.forEach((instance) => {
			instance.uptime_str = (instance.uptime * 100).toFixed(3);

            if(!instance.https_score) {
                instance.https_score = 0;
            }

            if(!instance.obs_score) {
                instance.obs_score = 0;
            }

			if(!strict) {
                let score = 0;
                let max = 0;

                if(instance.infos && instance.infos.prohibitedContent) {
                    if (Array.isArray(cq.languages) && cq.languages.length > 0) {
                        max += 1;

                        let _score = 0;
                        let _max = cq.languages.length;
                        cq.languages.forEach((language) => {
                            if (instance.infos.languages.includes(language)) {
                                _score++;
                            }
                        });

                        score += _score / _max;
                    }

                    if (Array.isArray(cq.allowed) && cq.allowed.length > 0) {
                        max += 1;

                        let _score = 0;
                        let _max = cq.allowed.length;
                        cq.allowed.forEach((content) => {
                            if (!instance.infos.prohibitedContent.includes(content)) {
                                _score++;
                            }
                        });

                        score += _score / _max;
                    }

                    if (Array.isArray(cq.prohibited) && cq.prohibited.length > 0) {
                        max += 1;

                        let _score = 0;
                        let _max = cq.prohibited.length;
                        cq.prohibited.forEach((content) => {
                            if (instance.infos.prohibitedContent.includes(content)) {
                                _score++;
                            }
                        });

                        score += _score / _max;
                    }
                }

                if(cq.min_users) {
                    try {
                        max += 1;

                        if(instance.users >= cq.min_users)
                            score += 1;
                    } catch(e) {}
                }

                if(cq.max_users) {
                    try {
                        max += 1;

                        if(instance.users <= cq.max_users)
                            score += 1;
                    } catch(e) {}
                }

                instance.score = 10 * score;
                instance.score_str = Math.floor(10 * score).toFixed(1);
            }
		});

        if(!strict) {
            shuffleArray(instances);

            instances.sort((a, b) => {
                return b.score - a.score;
            });
        }

		res.json({
			instances,
            languages: req.app.locals.langs,
            prohibitedContent: req.app.locals.ProhibitedContent
		});
	});
});

router.get('/list', (req, res) => {
    res.render('list', {
        languages: req.app.locals.langs,
        countries: req.app.locals.countries,
        prohibitedContent: req.app.locals.ProhibitedContent
    });
});

router.get('/list/advanced', (req, res) => {
    res.render('list', {
        languages: req.app.locals.langs,
        countries: req.app.locals.countries,
        prohibitedContent: req.app.locals.ProhibitedContent,
        advanced: true,
        fluid: true
    });
});

router.get('/list/old', async (req, res) => {
    let instances = await Instance.findAll({
        where: {
            uptime_all: {
                [Op.gt]: 0
            },
            dead: false,
            blacklisted: false,
            first_uptime: {
                [Op.ne]: null
            }
        }
    });

    let totalUsers = 0;
    let totalUpUsers = 0;
    let totalUp = 0;

    for(let instance of instances) {
        instance.uptime_str = (instance.uptime_all * 100).toFixed(3);

        instance.score = 50 * instance.uptime_all;

        if(instance.https_score)
            instance.score += instance.https_score / 5;

        if(instance.obs_score)
            instance.score += instance.obs_score / 5;

        if(instance.ipv6)
            instance.score += 10;

        if(instance.up)
            ++totalUp;

        if(instance.users) {
            totalUsers += instance.users;

            if(instance.up)
                totalUpUsers += instance.users;
        }
    }

    instances.sort((b, a) => {
        return a.score - b.score;
    });

    res.render('oldlist', {
        instances,
        totalUsers,
        totalUpUsers,
        totalUp
    });
});

router.get('/network', (req, res) => {
	DB.get('versions').find({
		instances: {
			$gt: 0
		}
	}, {sort:{
        instances: -1
    }}).then((versions) => {
        let totalUsers = 0;

        versions.forEach((version) => {
            totalUsers += version.users;
        });

        versions.forEach((version) => {
            version.users_ratio = version.users / totalUsers;
        });

		res.render('network', {versions});
	}).catch((e) => {
		res.sendStatus(500);
		console.error(e);
	});
});

router.get('/instances.json', morgan.api, (req, res) => {
	res.set('Access-Control-Allow-Origin', '*');

    Instance.findAll({
        where: {
            uptime_all: {
                [Op.gt]: 0
            },
            dead: false,
            blacklisted: false
        }
    }).then((instances) => {
        let jsons = [];

        instances.forEach((instance) => {
            let json = {};
            json.name = instance.name;
            json.title = instance.title;
            json.short_description = instance.short_description;
            json.description = instance.description;
            json.uptime = instance.uptime_all;
            json.up = instance.up;
            json.https_score = instance.https_score;
            json.https_rank = instance.https_rank;
            json.ipv6 = instance.ipv6;
            json.openRegistrations = instance.open_registrations;
            json.users = instance.users;
            json.statuses = instance.statuses;
            json.connections = instance.connections;

            jsons.push(json);
        });

        res.json(jsons);
    });
});

router.get('/:instance', async (req, res) => {
    let instance = await Instance.findOne({where: {name: req.params.instance}});
    if(!instance) return res.sendStatus(404);

    let pg_res_log = await pg.query('SELECT * FROM instances_log_entries WHERE instance=$1 ORDER BY id DESC', [
        instance.id
    ]);

    res.render('instance', {
        instance,
        filtered_desc: instance.description ? stripHtml(instance.description).result : null,
        log_entries: pg_res_log.rows.map(row => {
            let level_str;

            switch(row.level) {
                case 0:
                    level_str = 'INFO';
                    break;
                case 1:
                    level_str = 'WARNING';
                    break;
                case 2:
                    level_str = 'ERROR';
                    break;
            }

            return {
                date: row.date,
                date_str: row.date.toUTCString(),
                level: row.level,
                level_str,
                content: row.content
            };
        })
    });
});

router.get('/:instance/ping', async (req, res) => {
    const instance = await Instance.findOne({
        where: {
            name: req.params.instance
        }
    });

    if(!instance)
        return res.sendStatus(404);

    res.render('instance/ping', {
        instance,
        pings: await Ping.findAll({
            where: {
                instance: instance.id
            },
            order: [
                ['createdAt', 'DESC']
            ],
            limit: 100,
            include: [
                Probe
            ]
        })
    });
});

module.exports = router;

function shuffleArray(a) {
    for (let i = a.length; i; i--) {
        let j = Math.floor(Math.random() * i);
        [a[i - 1], a[j]] = [a[j], a[i - 1]];
    }
}
