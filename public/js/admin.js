'use strict';

/* global $, config, define, require */

// No dependencies in define(): NodeBB's build can fail to resolve a plugin ACP
// module that declares them (see nodebb-shotef/public/js/admin.js). They are
// loaded with require() in init instead.
define('admin/plugins/chatbridge', [], function () {
	var ACP = {};
	var HASH = 'chatbridge';

	function call(method, path) {
		return $.ajax({
			url: config.relative_path + '/api/v3/plugins/chatbridge' + path,
			method: method,
			headers: { 'x-csrf-token': config.csrf_token },
		}).then(function (body) { return (body && body.response) || {}; });
	}

	function esc(s) {
		return $('<span>').text(s == null ? '' : String(s)).html();
	}

	function showResult(provider, ok, text) {
		$('.chatbridge-result[data-provider="' + provider + '"]')
			.removeClass('text-success text-danger')
			.addClass(ok ? 'text-success' : 'text-danger')
			.text(text);
	}

	var OUTCOME_CLASS = { sent: 'text-bg-success', retrying: 'text-bg-warning', failed: 'text-bg-danger', dropped: 'text-bg-secondary' };

	function loadLog() {
		call('GET', '/log').then(function (r) {
			var rows = (r.entries || []).map(function (e) {
				var topic = e.url ? '<a href="' + esc(e.url) + '" target="_blank" rel="noopener">' + esc(e.title || e.url) + '</a>' : esc(e.title);
				return '<tr><td class="text-nowrap">' + esc(new Date(e.at).toLocaleString()) + '</td>' +
					'<td><span class="badge ' + (OUTCOME_CLASS[e.outcome] || 'text-bg-light') + '">' + esc(e.outcome) + '</span></td>' +
					'<td>' + esc(e.provider) + '</td>' +
					'<td><a href="' + config.relative_path + '/uid/' + esc(e.uid) + '">' + esc(e.uid) + '</a></td>' +
					'<td>' + esc(e.event) + '</td><td>' + topic + '</td>' +
					'<td class="small text-danger">' + esc(e.error) + '</td></tr>';
			});
			$('#chatbridge-log').html(rows.length ? rows.join('') : '<tr><td colspan="7" class="text-muted">Nothing sent yet.</td></tr>');
			$('#chatbridge-pending').text(r.pending ? r.pending + ' message(s) waiting to be retried.' : '');
		}).catch(function () {
			$('#chatbridge-log').html('<tr><td colspan="7" class="text-danger">Could not load the log.</td></tr>');
		});
	}

	ACP.init = function () {
		require(['settings', 'alerts'], function (settings, alerts) {
			var $form = $('.chatbridge-settings');
			settings.load(HASH, $form);

			$('#chatbridge-save').on('click', function (e) {
				e.preventDefault();
				settings.save(HASH, $form, function () {
					alerts.success('Saved.');
				});
			});

			$form.on('click', '.chatbridge-verify', function () {
				var p = $(this).attr('data-provider');
				showResult(p, true, 'Checking…');
				call('POST', '/providers/' + encodeURIComponent(p) + '/verify').then(function (r) {
					if (r.ok) showResult(p, true, 'Connected as ' + r.name + (r.isBot ? ' (bot)' : ' (not a bot account)'));
					else showResult(p, false, r.error);
				}).catch(function () { showResult(p, false, 'Request failed.'); });
			});

			$form.on('click', '.chatbridge-test-message', function () {
				var p = $(this).attr('data-provider');
				showResult(p, true, 'Sending…');
				call('POST', '/providers/' + encodeURIComponent(p) + '/test-message').then(function (r) {
					if (r.ok) showResult(p, true, 'Sent. Check your direct messages.');
					else showResult(p, false, r.error);
					loadLog();
				}).catch(function () { showResult(p, false, 'Request failed.'); });
			});

			$('#chatbridge-refresh-log').on('click', loadLog);
			loadLog();
		});
	};

	return ACP;
});
