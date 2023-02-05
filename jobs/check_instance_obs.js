'use strict';

const got = require('../helpers/got');
const querystring = require('querystring');
const Instance = require('../models/instance');

async function checkInstanceObs(options) {
    const instance = await Instance.findByPk(options.instance);

    if(!instance)
        throw new Error(`No instance has ID ${options.instance}.`);

    if(instance.latest_obs_check && instance.latest_obs_check.getTime() > new Date().getTime() - 24 * 60 * 60 * 1000)
        return;

    instance.latest_obs_check = new Date();

    let res = await got.post({
        url: 'https://http-observatory.security.mozilla.org/api/v1/analyze?'+ querystring.stringify({
            host: instance.name
        })
    }).json();

    if(res.state === 'FINISHED') {
        instance.obs_rank = res.grade;
        instance.obs_score = res.score;

        await instance.save();
    }
}

module.exports = checkInstanceObs;
