process.chdir(__dirname);
var os = require('os');
var disk = require('diskusage');
var child_process = require('child_process');
var async = require('async');
var fs = require("fs");
var express = require('express');
var moment = require("moment");
var sprintf = require('sprintf-js').sprintf;
var rtp_mod = require("./rtp.js");
var uuidgen = require('uuid/v4');
var xmlhttprequest = require('xmlhttprequest');
global.XMLHttpRequest = xmlhttprequest.XMLHttpRequest;
var EventEmitter = require('eventemitter3');
var util = require('util');
//var RTCAudioSourceAlsa = require("./alsaaudio.js");
var uuidParse = require('uuid-parse');
var pstcore = require('pstcore-js');

var UPSTREAM_DOMAIN = "upstream.";
var SERVER_DOMAIN = "";
var CAPTURE_DOMAIN = UPSTREAM_DOMAIN;
var DRIVER_DOMAIN = UPSTREAM_DOMAIN + UPSTREAM_DOMAIN;
var PT_STATUS = 100;
var PT_CMD = 101;
var PT_FILE = 102;
var PT_ENQUEUE = 110;
var PT_SET_PARAM = 111;

var SIGNALING_HOST = "peer.picam360.com";
// var SIGNALING_HOST = "test-peer-server.herokuapp.com";
var SIGNALING_PORT = 443;
var SIGNALING_SECURE = true;

function watchFile(filepath, oncreate, ondelete) {
	var fs = require('fs'),
		path = require('path'),
		filedir = path
			.dirname(filepath),
		filename = path.basename(filepath);
	fs.watch(filedir, function(event, who) {
		if (event === 'rename' && who === filename) {
			if (fs.existsSync(filepath)) {
				if (oncreate)
					oncreate();
			} else {
				if (ondelete)
					ondelete();
			}
		}
	});
}

function removeArray(array, value) {
	for (var i = array.length - 1; i >= 0; i--) {
		if (array[i] === value) {
			array.splice(i, 1);
		}
	}
}

function clone(src) {
	var dst = {}
	for (var k in src) {
		dst[k] = src[k];
	}
	return dst;
}

var plugin_host = {};
var plugins = [];
var rtp_rx_conns = [];
var cmd2upstream_list = [];
var cmd_list = [];
var watches = [];
var statuses = [];
var filerequest_list = [];
var m_port_index = 0;

var upstream_info = "";
var upstream_menu = "";
var upstream_quaternion = [0, 0, 0, 1.0];
var upstream_north = 0;

var is_recording = false;
var memoryusage_start = 0;
var GC_THRESH = 16 * 1024 * 1024; // 16MB
var capture_if;
var capture_process;
var m_request_call = "";
var m_audio_source = null;

var http = null;

var options = [];

async.waterfall([
	function(callback) { // argv
		var conf_filepath = 'config.json';
		for (var i = 0; i < process.argv.length; i++) {
			if (process.argv[i] == "-c") {
				conf_filepath = process.argv[i + 1];
				i++;
			}
		}
		var tmp_conf_filepath = "/tmp/picam360-server.conf.json";
		var cmd = "grep -v -e '^\s*#' " +
			conf_filepath + " > " + tmp_conf_filepath;
		child_process.exec(cmd, function() {
			console.log("load config file : " + conf_filepath);
			options = JSON
				.parse(fs.readFileSync(tmp_conf_filepath, 'utf8'));
			child_process.exec("rm " + tmp_conf_filepath);

			callback(null);
		});
	},
	function(callback) { // exit sequence
		function cleanup() {
			if (m_audio_source) {
				console.log('audio close');
				m_audio_source.close();
				m_audio_source = null;
			}
		}
		process.on('uncaughtException', (err) => {
			cleanup();
			throw err;
		});
		process.on('SIGINT', function() {
			cleanup();
			console.log("exit process done");
			process.exit();
		});
		process.on('SIGUSR2', function() {
			if (agent.server) {
				agent.stop();
			} else {
				agent.start({
					port: 9999,
					bind_to: '192.168.3.103',
					ipc_port: 3333,
					verbose: true
				});
			}
		});
		callback(null);
	},
	function(callback) {
		console.log("init pstcore");
		var config_json = "";
		config_json += "{\n";
		config_json += "	\"plugin_paths\" : [\n";
		config_json += "		\"plugins/pvf_loader_st.so\",\n";
		config_json += "		\"plugins/libde265_decoder_st.so\",\n";
		config_json += "		\"plugins/vt_decoder_st.so\",\n";
		config_json += "		\"plugins/pgl_renderer_st.so\"\n";
		config_json += "	]\n";
		config_json += "}\n";
		pstcore.pstcore_init(config_json);
		
		setInterval(() => {
			pstcore.pstcore_poll_events();
		}, 33);
		
		callback(null);
	},
	function(callback) {
		console.log("init data stream");

		var active_frame = null;
		var startTime = new Date();
		var num_of_frame = 0;
		var fps = 0;

		rtp_mod.send_error = function(conn, err) {
			setTimeout(function() {
				var name = "error";
				var value = err;
				var status = "<picam360:status name=\"" + name +
					"\" value=\"" + value + "\" />";
//				var pack = rtp
//					.build_packet(new Buffer(status, 'ascii'), PT_STATUS);
//				rtp.sendpacket(pack);
			}, 1000);
		}

		rtp_mod.remove_conn = function(conn) {
			for (var i = rtp_rx_conns.length - 1; i >= 0; i--) {
				if (rtp_rx_conns[i] === conn) {
					console.log("connection closed : " +
						rtp_rx_conns[i].attr.ip);
					clearInterval(conn.attr.timer);
					conn.close();
					if(conn.attr.pst){
						pstcore.pstcore_destroy_pstreamer(conn.attr.pst);
						conn.attr.pst = 0;
					}

					rtp_rx_conns.splice(i, 1);
				}
			}
		};
		
		rtp_mod.add_conn = function(conn) {
			var ip;
			if (conn.peerConnection) { // webrtc
				ip = " via webrtc";
			} else {
				ip = " via websocket";
			}
			if (rtp_rx_conns.length >= 2) { // exceed client
				console.log("exceeded_num_of_clients : " + ip);
				rtp_mod.send_error(conn, "exceeded_num_of_clients");
				return;
			} else {
				console.log("connection opend : " + ip);
			}
			
			conn.frame_info = {
				stream_uuid: uuidgen(),
				renderer_uuid: uuidgen(),
				snapper_uuid: uuidgen(),
				recorder_uuid: uuidgen(),
				mode: options.frame_mode || "WINDOW",
				width: options.frame_width || 512,
				height: options.frame_height || 512,
				stream_def: options.stream_def || "h264",
				fps: options.frame_fps || 5,
				bitrate: options.frame_bitrate,
			};

			conn.attr = {
				ip: ip,
				frame_queue: [],
				fps: 5,
				latency: 1.0,
				min_latency: 1.0,
				frame_num: 0,
				tmp_num: 0,
				tmp_latency: 0,
				tmp_time: 0,
				timeout: false,
				param_pendings: [],
			};
			var rtp = rtp_mod.Rtp(conn);
			new Promise((resolve, reject) => {
				rtp.set_callback(function(packet) {
					conn.attr.timeout = new Date().getTime();
					if (packet.GetPayloadType() == PT_CMD) {
						var cmd = packet.GetPacketData()
							.toString('ascii', packet.GetHeaderLength());
						var split = cmd.split('\"');
						var id = split[1];
						var value = split[3].split(' ');
						if (value[0] == "frame_mode") {
							conn.frame_info.mode = value[1];
							return;
						} else if (value[0] == "frame_width") {
							conn.frame_info.width = value[1];
							return;
						} else if (value[0] == "frame_height") {
							conn.frame_info.height = value[1];
							return;
						} else if (value[0] == "frame_fps") {
							conn.frame_info.fps = value[1];
							return;
						} else if (value[0] == "stream_def") {
							conn.frame_info.stream_def = value[1];
							return;
						} else if (value[0] == "frame_bitrate") {
							conn.frame_info.bitrate = value[1];
							return;
						} else if (value[0] == "ping") {
							var status = "<picam360:status name=\"pong\" value=\"" +
								value[1] +
								" " +
								new Date().getTime() +
								"\" />";
							var pack = rtp
								.build_packet(new Buffer(status, 'ascii'), PT_STATUS);
							rtp.sendpacket(pack);
							return;
						} else if (value[0] == "set_timediff_ms") {
							resolve();
						}
					}
				});
			}).then(() => {
				if (!options['stream_defs'] || !options['stream_defs'][conn.frame_info.stream_def]) {
					console.log("no stream definition : " + conn.frame_info.stream_def);
					return;
				}
				var o_str = options['stream_defs'][conn.frame_info.stream_def];
				
				var def = "pvf_loader";
				var url = "file://Users/takuma/Downloads/ancient_8k_1024p_4mps.pvf";
				conn.attr.pst = pstcore.pstcore_build_pstreamer(def);
				
				pstcore.pstcore_set_param(conn.attr.pst, "pvf_loader", "url", url);
				pstcore.pstcore_set_dequeue_callback(conn.attr.pst, (data)=>{
					//console.log("dequeue " + data.length);
					var CHUNK_SIZE = conn.getMaxPayload() - rtp_mod.PacketHeaderLength;
					for(var cur=0;cur<data.length;cur+=CHUNK_SIZE){
						var chunk = data.slice(cur, cur + CHUNK_SIZE);
						var pack = rtp.build_packet(chunk, PT_ENQUEUE);
						rtp.sendpacket(pack);
					}
					{//end packet
						var pack = rtp.build_packet(new Buffer("<eob/>", 'ascii'), PT_ENQUEUE);
						rtp.sendpacket(pack);
					}
				});
		
				pstcore.pstcore_add_set_param_done_callback((msg)=>{
					//console.log("set_param " + msg);
					conn.attr.param_pendings.push(msg);
				});
				pstcore.pstcore_start_pstreamer(conn.attr.pst);

				rtp_rx_conns.push(conn);

				conn.attr.timer = setInterval(function() {
					try{
						var now = new Date().getTime();
						if (now - conn.attr.timeout > 60000) {
							console.log("timeout");
							throw "TIMEOUT";
						}
						if(conn.attr.param_pendings.length > 0) {
							var msg = "[" + conn.attr.param_pendings.join(',') + "]";
							var pack = rtp.build_packet(new Buffer(msg, 'ascii'), PT_SET_PARAM);
							rtp.sendpacket(pack);
							conn.attr.param_pendings = [];
						}
					}catch(err){
						rtp_mod.remove_conn(conn);
					}
				}, 33);
				rtp.set_callback(function(packet) {
					conn.attr.timeout = new Date().getTime();
					if (packet.GetPayloadType() == PT_SET_PARAM) { // set_param
						var str = (new TextDecoder)
							.decode(packet.GetPayload());
						var list = JSON.parse(str);
						for(var ary of list){
							pstcore.pstcore_set_param(conn.attr.pst, ary[0], ary[1], ary[2]);
						}
					}
				});
			});
		}
		callback(null);
	},
	function(callback) { // gc
		console.log("gc");
		var disk_free = 0;
		setInterval(function() {
			disk.check('/tmp', function(err, info) {
				disk_free = info.available;
			});
		}, 1000);
		setInterval(function() {
			if (global.gc && os.freemem() < GC_THRESH) {
				console.log("gc : free=" + os.freemem() + " usage=" +
					process.memoryUsage().rss);
				console.log("disk_free=" + disk_free);
				global.gc();
			}
		}, 100);
		callback(null);
	},
	function(callback) { // start up websocket server
		console.log("websocket server starting up");
		var app = require('express')();
		http = require('http').Server(app);
		app
			.get('/img/*.jpeg', function(req, res) {
				var url = req.url.split("?")[0];
				var query = req.url.split("?")[1];
				var filepath = 'userdata/' + url.split("/")[2];
				console.log(url);
				console.log(query);
				console.log(filepath);
				fs
					.readFile(filepath, function(err, data) {
						if (err) {
							res.writeHead(404);
							res.end();
							console.log("404");
						} else {
							res
								.writeHead(200, {
									'Content-Type': 'image/jpeg',
									'Content-Length': data.length,
									'Cache-Control': 'private, no-cache, no-store, must-revalidate',
									'Expires': '-1',
									'Pragma': 'no-cache',
								});
							res.end(data);
							console.log("200");
						}
					});
			});
		app.get('/img/*.mp4', function(req, res) {
			var url = req.url.split("?")[0];
			var query = req.url.split("?")[1];
			var filepath = 'userdata/' + url.split("/")[2];
			console.log(url);
			console.log(query);
			console.log(filepath);
			fs.readFile(filepath, function(err, data) {
				if (err) {
					res.writeHead(404);
					res.end();
					console.log("404");
				} else {
					var range = req.headers.range // bytes=0-1
					if (!range) {
						res.writeHead(200, {
							"Content-Type": "video/mp4",
							"X-UA-Compatible": "IE=edge;chrome=1",
							'Content-Length': data.length
						});
						res.end(data)
					} else {
						var total = data.length;
						var split = range.split(/[-=]/);
						var ini = +split[1];
						var end = split[2] ? +split[2] : total - 1;
						var chunkSize = end - ini + 1;
						res.writeHead(206, {
							"Content-Range": "bytes " + ini + "-" + end +
								"/" + total,
							"Accept-Ranges": "bytes",
							"Content-Length": chunkSize,
							"Content-Type": "video/mp4",
						})
						res.end(data.slice(ini, chunkSize + ini))
					}
				}
			});
		});
		app.use(express.static('www')); // this need be set
		http.listen(9001, function() {
			console.log('listening on *:9001');
		});
		callback(null);
	},
	function(callback) {
		// websocket
		var WebSocket = require("ws");
		var server = new WebSocket.Server({ server: http });

		server.on("connection", dc => {
			class DataChannel extends EventEmitter {
				constructor() {
					super();
					var self = this;
					dc.on('message', function(data) {
						self.emit('data', data);
					});
					dc.on('close', function(event) {
						self.close();
					});
				}
				getMaxPayload() {
					return dc._maxPayload;
				}
				send(data) {
					if (dc.readyState != 1) {
						return;
					}
					if (!Array.isArray(data)) {
						data = [data];
					}
					try {
						for (var i = 0; i < data.length; i++) {
							dc.send(data[i]);
						}
					} catch (e) {
						console.log('error on dc.send');
						this.close();
					}
				}
				close() {
					dc.close();
					console.log('WebSocket closed');
					rtp_mod.remove_conn(this);
				}
			}
			var conn = new DataChannel();
			rtp_mod.add_conn(conn);
		});
		callback(null);
	},
	function(callback) {
		// wrtc
		if (options["wrtc_enabled"]) {
			var P2P_API_KEY = "v8df88o1y4zbmx6r";
			global.Blob = "blob";
			global.File = "file";
			global.WebSocket = require("ws");
			global.window = require("wrtc");
			global.window.evt_listener = [];
			global.window.postMessage = function(message, origin) {
				console.log(message);
				var event = {
					source: global.window,
					data: message,
				};
				if (global.window.evt_listener["message"]) {
					global.window.evt_listener["message"].forEach(function(
						callback) {
						callback(event);
					});
				}
			};
			global.window.addEventListener = function(name, callback, bln) {
				if (!global.window.evt_listener[name]) {
					global.window.evt_listener[name] = [];
				}
				global.window.evt_listener[name].push(callback);
			}
			var uuid = options["wrtc_uuid"] || uuidgen();
			console.log("\n\n\n");
			console.log("webrtc uuid : " + uuid);
			console.log("\n\n\n");
			var sig_options = {
				host: SIGNALING_HOST,
				port: SIGNALING_PORT,
				secure: SIGNALING_SECURE,
				key: P2P_API_KEY,
				local_peer_id: uuid,
				iceServers: [{
					"urls": "stun:stun.l.google.com:19302"
				},
				{
					"urls": "stun:stun1.l.google.com:19302"
				},
				{
					"urls": "stun:stun2.l.google.com:19302"
				},
				],
				debug: options.debug || 0,
			};
			if (options.turn_server) {
				options.iceServers.push({
					urls: 'turn:turn.picam360.com:3478',
					username: "picam360",
					credential: "picam360"
				});
			}
			var Signaling = require("./signaling.js").Signaling;
			var connect = function() {
				var pc_map = {};
				var sig = new Signaling(sig_options);
				sig.connect(function() {
					sig.start_ping();
				});
				sig.onrequestoffer = function(request) {
					var video_source = null;
					var pc = new global.window.RTCPeerConnection({
						sdpSemantics: 'unified-plan',
						iceServers: sig_options.iceServers,
					});
					pc_map[request.src] = pc;

					if (options.audio_device && !m_audio_source) {
						console.log('audio opened');
						m_audio_source = new RTCAudioSourceAlsa({
							channelCount: 2,
							device: options.audio_device,
						});
					}
					if (m_audio_source) { // audio
						var track = m_audio_source.createTrack(request.src);
						pc.addTransceiver(track);
					}
					{ // video
						console.log('video opened');
						video_source = new global.window.nonstandard.RTCVideoSource();
						var track = video_source.createTrack();
						pc.addTransceiver(track);
					}

					var dc = pc.createDataChannel('data');
					dc.onopen = function() {
						console.log('Data channel connection success');
						class DataChannel extends EventEmitter {
							constructor() {
								super();
								var self = this;
								this.peerConnection = pc;
								dc.addEventListener('message', function(data) {
									self.emit('data', Buffer.from(new Uint8Array(data.data)));
								});
							}
							getMaxPayload() {
								return dc.maxRetransmits;
							}
							send(data) {
								if (dc.readyState != 'open') {
									return;
								}
								if (!Array.isArray(data)) {
									data = [data];
								}
								try {
									for (var i = 0; i < data.length; i++) {
										dc.send(Uint8Array.from(data[i]).buffer);
									}
								} catch (e) {
									console.log('error on dc.send');
									this.close();
								}
							}
							add_frame(i420Frame) {
								video_source.onFrame(i420Frame);
							}
							close() {
								dc.close();
								pc.close();
								console.log('Data channel closed');
							}
						}
						dc.DataChannel = new DataChannel();
						rtp_mod.add_conn(dc.DataChannel);
					}

					pc.createOffer().then(function(sdp) {
						console.log('setLocalDescription');
						pc.setLocalDescription(sdp);
						var lines = sdp.sdp.split('\r\n');
						for (var i = 0; i < lines.length; i++) {
							// //h264
							// if(lines[i].startsWith('a=rtpmap:96 VP8/90000')){
							// lines[i] = lines[i].replace(
							// 'a=rtpmap:96 VP8/90000',
							// 'a=rtpmap:107 H264/90000\r\n' +
							// 'a=rtpmap:96 VP8/90000');
							// }
							// //vp9
							// if(lines[i].startsWith('m=video 9')){
							// lines[i] = lines[i].replace(
							// 'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 127',
							// 'm=video 9 UDP/TLS/RTP/SAVPF 107 98 96 97 99 100 101 127');
							// }
							// bitrate
							if (lines[i].startsWith('m=video 9')) {
								if (options.frame_bitrate) {
									lines[i] = lines[i] + '\r\n' +
										'b=AS:' + options.frame_bitrate;
								}
							}
						}
						sdp.sdp = lines.join('\r\n');

						sig.offer(request.src, sdp);
					}).catch(function(err) {
						console.log('failed offering:' +
							err);
					});
					pc.onicecandidate = function(event) {
						if (event.candidate) {
							sig.candidate(request.src, event.candidate);
						} else {
							// All ICE candidates have been sent
						}
					};
					pc.onconnectionstatechange = function(event) {
						console.log('peer connection state changed : ' + pc.connectionState);
						switch (pc.connectionState) {
							case "connected":
								// The connection has become fully connected
								break;
							case "disconnected":
							case "failed":
							case "closed":
								console.log('peer connection closed');
								pc.close();
								dc.close();
								if (m_audio_source) {
									m_audio_source.deleteTrack(request.src);
								}
								if (dc.DataChannel) {
									rtp_mod.remove_conn(dc.DataChannel);
								}
								break;
						}
					}
				};
				sig.onanswer = function(answer) {
					if (pc_map[answer.src]) {
						pc_map[answer.src].setRemoteDescription(answer.payload.sdp);
					}
				};
				sig.oncandidate = function(candidate) {
					if (pc_map[candidate.src] && candidate.payload.ice.candidate) {
						pc_map[candidate.src].addIceCandidate(candidate.payload.ice);
					}
				};
				sig.onclose = function(e) {
					// console.log('Socket closed : dump error object below');
					// console.dir(e);
					setTimeout(() => {
						console.log('Try to reconnect');
						connect();
					}, 1000);
				};
			};
			connect();
		}
		callback(null);
	},
	function(callback) {
		// plugin host
		var m_view_quaternion = [0, 0, 0, 1.0];
		// cmd handling
		function command_handler(value, conn) {
			var split = value.split(' ');
			var domain = split[0].split('.');
			if (domain.length != 1 && domain[0] != "picam360_server") {
				// delegate to plugin
				for (var i = 0; i < plugins.length; i++) {
					if (plugins[i].name && plugins[i].name == domain[0]) {
						if (plugins[i].command_handler) {
							split[0] = split[0].substring(split[0].indexOf('.') + 1);
							plugins[i].command_handler(split.join(' '));
							break;
						}
					}
				}
				return;
			}
			if (split[0] == "ping") { } else if (split[0] == "get_file") {
				filerequest_list.push({
					filename: split[1],
					key: split[2],
					conn: conn
				});
			} else if (split[0] == "set_vstream_param") {
				var id = conn.frame_info.renderer_uuid;
				if (id) {
					var cmd = CAPTURE_DOMAIN + value + " -u " + id;
					plugin_host.send_command(cmd, conn);

					var split = value.split(' ');
					for (var i = 0; i < split.length; i++) {
						var separator = (/[=,\"]/);
						var _split = split[i].split(separator);
						if (_split[0] == "view_quat") {
							m_view_quaternion = [parseFloat(_split[1]),
							parseFloat(_split[2]),
							parseFloat(_split[3]),
							parseFloat(_split[4])
							];
						}
					}
				}
			} else if (split[0] == "snap") {
				var id = conn.frame_info.snapper_uuid;
				if (id) {
					var dirname = moment().format('YYYYMMDD_HHmmss');
					var filepath = (options['record_path'] || 'Videos') + '/' + dirname;
					var cmd = CAPTURE_DOMAIN + "set_vstream_param";
					cmd += " -p base_path=" + filepath;
					cmd += " -p mode=RECORD";
					cmd += " -u " + id;
					plugin_host.send_command(cmd, conn);
					console.log("snap");
				}
			} else if (split[0] == "start_record") {
				if (conn.frame_info.is_recording)
					return;
				var id = conn.frame_info.recorder_uuid;
				if (id) {
					var dirname = moment().format('YYYYMMDD_HHmmss');
					var filepath = (options['record_path'] || 'Videos') + '/' + dirname;
					var cmd = CAPTURE_DOMAIN + "set_vstream_param";
					cmd += " -p base_path=" + filepath;
					cmd += " -p mode=RECORD";
					cmd += " -u " + id;
					plugin_host.send_command(cmd, conn);
					conn.frame_info.is_recording = true;
					console.log("start record");
				}
			} else if (split[0] == "stop_record") {
				var id = conn.frame_info.recorder_uuid;
				if (id) {
					var cmd = CAPTURE_DOMAIN + "set_vstream_param";
					cmd += " -p mode=IDLE";
					cmd += " -u " + id;
					plugin_host.send_command(cmd, conn);
					conn.frame_info.is_recording = false;
					console.log("stop record");
				}
			} else if (split[0] == "request_call") {
				m_request_call = split[1];
			}
		}

		function send_file(filename, key, conn, data) {
			var chunksize = 63 * 1024;
			var length;
			for (var i = 0, seq = 0; i < data.length; i += length, seq++) {
				var eof;
				if (i + chunksize >= data.length) {
					eof = true;
					length = data.length - i;
				} else {
					eof = false;
					length = chunksize;
				}
				var header_str = sprintf("<picam360:file name=\"%s\" key=\"%s\" status=\"200\" seq=\"%d\" eof=\"%s\" />", filename, key, seq, eof
					.toString());
				var header = new Buffer(header_str, 'ascii');
				var len = 2 + header.length + length;
				var buffer = new Buffer(len);
				buffer.writeUInt16BE(header.length, 0);
				header.copy(buffer, 2);
				data.copy(buffer, 2 + header.length, i, i + length);
//				var pack = rtp.build_packet(buffer, PT_FILE);
//				rtp.sendpacket(pack);
			}
		}

		function filerequest_handler(filename, key, conn) {
			fs.readFile("www/" + filename, function(err, data) {
				if (err) {
					var header_str = "<picam360:file name=\"" + filename +
						"\" key=\"" + key + "\" status=\"404\" />";
					data = new Buffer(0);
					console.log("unknown :" + filename + ":" + key);
					var header = new Buffer(header_str, 'ascii');
					var len = 2 + header.length;
					var buffer = new Buffer(len);
					buffer.writeUInt16BE(header.length, 0);
					header.copy(buffer, 2);
//					var pack = rtp.build_packet(buffer, PT_FILE);
//					rtp.sendpacket(pack);
				} else {
					send_file(filename, key, conn, data);
				}
			});
		}
		setInterval(function() {
			if (cmd_list.length) {
				var cmd = cmd_list.shift();
				command_handler(cmd.value, cmd.conn);
			}
			if (filerequest_list.length) {
				var filerequest = filerequest_list.shift();
				filerequest_handler(filerequest.filename, filerequest.key, filerequest.conn);
			}
		}, 20);
		plugin_host.send_command = function(value, conn) {
			if (value.startsWith(UPSTREAM_DOMAIN)) {
				cmd2upstream_list
					.push(value.substr(UPSTREAM_DOMAIN.length));
			} else {
				cmd_list.push({
					value: value,
					conn: conn
				});
			}
		};
		plugin_host.get_vehicle_quaternion = function() {
			return upstream_quaternion;
		};
		plugin_host.get_vehicle_north = function() {
			return upstream_north;
		};
		plugin_host.get_view_quaternion = function() {
			return m_view_quaternion;
		};
		plugin_host.add_watch = function(name, callback) {
			watches[name] = callback;
		};
		plugin_host.add_status = function(name, callback) {
			statuses[name] = callback;
		};

		plugin_host.add_watch(UPSTREAM_DOMAIN + "quaternion", function(
			value) {
			var separator = (/[,]/);
			var split = value.split(separator);
			upstream_quaternion = [parseFloat(split[0]),
			parseFloat(split[1]), parseFloat(split[2]),
			parseFloat(split[3])
			];
		});

		plugin_host.add_watch(UPSTREAM_DOMAIN + "north", function(value) {
			upstream_north = parseFloat(value);
		});

		plugin_host.add_watch(UPSTREAM_DOMAIN + "info", function(value) {
			upstream_info = value;
		});

		plugin_host.add_watch(UPSTREAM_DOMAIN + "menu", function(value) {
			upstream_menu = value;
		});

		plugin_host.add_status("is_recording", function(conn) {
			return {
				succeeded: true,
				value: conn.frame_info.is_recording
			};
		});

		plugin_host.add_status("request_call", function() {
			return {
				succeeded: m_request_call != "",
				value: m_request_call
			};
		});

//		plugin_host.add_status("p2p_num_of_members", function() {
//			return {
//				succeeded: true,
//				value: rtp_mod.p2p_num_of_members()
//			};
//		});

		plugin_host.add_status("info", function() {
			return {
				succeeded: upstream_info != "",
				value: upstream_info
			};
		});

		plugin_host.add_status("menu", function() {
			return {
				succeeded: upstream_menu != "",
				value: upstream_menu
			};
		});

		callback(null);
	},
	function(callback) {
		// load plugin
		if (options["plugin_paths"]) {
			for (var k in options["plugin_paths"]) {
				var plugin_path = options["plugin_paths"][k];
				console.log("loading... " + plugin_path);
				var plugin = require("./" + plugin_path)
					.create_plugin(plugin_host);
				plugins.push(plugin);
			}
			for (var i = 0; i < plugins.length; i++) {
				if (plugins[i].init_options) {
					plugins[i].init_options(options);
				}
			}
		}
		callback(null);
	},
	function(callback) {
		// aws_iot
		// need to after plugin loaded
		// wrtc could conflict in connection establishing
		if (options.aws_iot && options.aws_iot.enabled) {
			if (!options.aws_iot.client_id) {
				options.aws_iot.client_id = "picam360-" + uuidgen();
			}
			// making sure connection established
			var awsIot = require('aws-iot-device-sdk');
			var thingShadow = awsIot
				.thingShadow({
					keyPath: options.aws_iot.private_key,
					certPath: options.aws_iot.certificate,
					caPath: options.aws_iot.root_ca,
					clientId: options.aws_iot.client_id,
					region: options.aws_iot.region,
					baseReconnectTimeMs: 4000,
					keepalive: 300,
					protocol: "mqtts",
					// port: undefined,
					host: options.aws_iot.host,
					debug: options.aws_iot.debug,
				});

			thingShadow
				.on('connect', function() {
					console.log('Connected to AWS IOT.');

					for (var i = 0; i < plugins.length; i++) {
						if (plugins[i].aws_iot_conneced) {
							plugins[i]
								.aws_iot_conneced(thingShadow, options.aws_iot.thing_name);
						}
					}

					thingShadow
						.register(options.aws_iot.thing_name, {}, function() {
							for (var i = 0; i < plugins.length; i++) {
								if (plugins[i].aws_iot_registered) {
									plugins[i]
										.aws_iot_registered(thingShadow, options.aws_iot.thing_name);
								}
							}
						});
				});

			thingShadow.on('close', function() {
				console.log('close');
			});

			thingShadow.on('error', function(err) {
				console.log('Error on AWS IOT. ' + err);
			});
		}
		callback(null);
	}
], function(err, result) { });