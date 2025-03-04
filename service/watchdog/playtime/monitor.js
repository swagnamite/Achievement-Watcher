'use strict';

const path = require('path');
const fs = require('@xan105/fs');
const request = require('request-zero');
const WQL = require('wql-process-monitor');
const humanizeDuration = require("humanize-duration");
const EventEmitter = require("emittery");
const Timer = require('./timer.js');
const TimeTrack = require('./track.js');
const { findByReadingContentOfKnownConfigfilesIn } = require('./steam_appid_find.js');

const debug = new (require("@xan105/log"))({
  console: true,
  file: path.join(process.env['APPDATA'],"Achievement Watcher/logs/playtime.log")
});

const blacklist = require("./filter.json");

const filter = {
	ignore: blacklist.ignore, //WMI WQL FILTER
	mute: {
		dir: [
			process.env['APPDATA'],
			process.env['LOCALAPPDATA'],
			process.env['ProgramFiles'],
			process.env['ProgramFiles(x86)'],
			path.join(process.env['SystemRoot'],"System32"),
			path.join(process.env['SystemRoot'],"SysWOW64")
		],
		file: blacklist.mute
	}	
};

async function init(){

	const emitter = new EventEmitter();

	let nowPlaying = [];
	let gameIndex = await getGameIndex();

	await WQL.promises.createEventSink();
	const processMonitor = await WQL.promises.subscribe({ 
		/*
		Elevated process (scene release are usually UAC elevated via appcompatibility out of the box)
		Set built-in filter to false 
		cf: https://github.com/xan105/node-processMonitor/issues/2
		*/
		filterWindowsNoise: false, filterUsualProgramLocations: false,
		filter: filter.ignore 
	});

	processMonitor.on("creation", async ([process,pid,filepath]) => {

	  let game;
	  
	  if (filepath) 
	  {
      if (filter.mute.dir.some( dirpath => path.parse(filepath).dir.startsWith(dirpath))) return; //Mute event

      const games = gameIndex.filter(game => game.binary === process && !game.name.includes("Demo"));

      if (games.length === 1) {
        if (filter.mute.file.some( bin => bin.toLowerCase() === process.toLowerCase() )) return; //Mute event
        game = games[0];
      }
	    else if (games.length > 1) {
        debug.log(`More than 1 entry for "${process}"`);
        const gameDir = path.parse(filepath).dir;
        debug.log(`Try to find appid from a cfg file in "${gameDir}"`);
        try{
          const appid = await findByReadingContentOfKnownConfigfilesIn(gameDir);
          debug.log(`Found appid: ${appid}`);
          game = games.find(game => game.appid == appid);
        }catch(err){
          debug.warn(err);
        }
 
      }
	  } 
	  else 
	  {
      if (filter.mute.file.some( bin => bin.toLowerCase() === process.toLowerCase() )) return; //Mute event
      game = gameIndex.find(game => game.binary === process && !game.name.includes("Demo"));
	  }
	  
	  if(game) 
      {
      debug.log(`DB Hit for ${game.name}(${game.appid}) in "${filepath}"`);
      if (!nowPlaying.includes(game)) { //Only one instance allowed

        const playing = Object.assign(game,{ 
        pid: pid,
        timer: new Timer
        });
        debug.log(playing);
        
        nowPlaying.push(playing);
      } else {
        debug.error("Only one game instance allowed");
      }
    
      emitter.emit("notify", [game]);

      }
  
	});

	processMonitor.on("deletion",([process,pid]) => {
	  
	  const game = nowPlaying.find(game => game.pid === pid && game.binary === process);
	  if (game)
	  {
		debug.log(`Stop playing ${game.name}(${game.appid})`);
		game.timer.stop();
		const playedtime = game.timer.played;
		
		let index = nowPlaying.indexOf(game);
		if (index !== -1) { nowPlaying.splice(index, 1); } //remove from nowPlaying
	 
		debug.log("playtime: " + Math.floor( playedtime / 60 ) + "min");
		
		let humanized;
		if (playedtime < 60) {
			humanized = humanizeDuration(playedtime * 1000, { language: "en", units: ["s"] }); 
		} else {
			humanized = humanizeDuration(playedtime * 1000, { language: "en", conjunction: " and ", units: ["h", "m"], round: true });
		}
		
		TimeTrack(game.appid,playedtime).catch((err)=>{debug.error(err)});
		
		emitter.emit("notify", [game, "You played for " + humanized]);

	  }

	});

	return emitter;
};

async function getGameIndex(){
	
	const filePath = path.join(process.env['APPDATA'],"Achievement Watcher/steam_cache/schema","gameIndex.json");
	
	let gameIndex;
	
	try{
		if (await fs.existsAndIsYoungerThan(filePath,{timeUnit: 'd', time: 1})) {
			gameIndex = JSON.parse( await fs.readFile(filePath,"utf8") );
		} else {
			try{
				gameIndex = ( await request.getJson("https://api.xan105.com/v2/steam/gameindex") ).data;
				await fs.writeFile(filePath,JSON.stringify(gameIndex),"utf8").catch((err)=>{debug.error(err)});
			}catch(err){
				debug.error(err);
				gameIndex = JSON.parse( await fs.readFile(filePath,"utf8") );
			}
		}
	}catch(err){
		debug.error(err);
		gameIndex = [];
	}

	return gameIndex;
}

module.exports = { init };