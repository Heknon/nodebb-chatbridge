<div class="acp-page-container">
	<div class="d-flex align-items-center justify-content-between mb-3">
		<h4 class="fw-bold mb-0"><i class="fa fa-comments"></i> Chat Bridge</h4>
		<button id="chatbridge-save" class="btn btn-primary btn-sm"><i class="fa fa-floppy-disk"></i> Save</button>
	</div>
	<p class="text-muted">Sends forum notifications to users as chat direct messages. Whoever NodeBB notifies gets the message. Users who turn a notification type off in their NodeBB settings stop getting it here too.</p>

	<form role="form" class="chatbridge-settings">
		<div class="card mb-3">
			<div class="card-body">
				<h5 class="fw-bold">Events</h5>
				{{{ each events }}}
				<div class="form-check form-switch mb-1">
					<input class="form-check-input" type="checkbox" id="{./name}" name="{./name}">
					<label class="form-check-label" for="{./name}">{./label}</label>
				</div>
				{{{ end }}}

				<div class="row mt-3">
					<div class="col-sm-6 mb-2">
						<label class="form-label" for="excerptLength">Reply excerpt length</label>
						<input class="form-control" type="number" min="0" max="2000" id="excerptLength" name="excerptLength" placeholder="300">
						<div class="form-text">Characters of the reply to include. 0 turns excerpts off.</div>
					</div>
					<div class="col-sm-6 mb-2">
						<label class="form-label" for="baseUrl">Forum URL for links</label>
						<input class="form-control" type="url" id="baseUrl" name="baseUrl" placeholder="(the forum's configured URL)">
					</div>
				</div>
			</div>
		</div>

		{{{ each providers }}}
		<div class="card mb-3" data-provider="{./id}">
			<div class="card-body">
				<div class="d-flex align-items-center justify-content-between">
					<h5 class="fw-bold mb-0">{./label}</h5>
					<div class="form-check form-switch mb-0">
						<input class="form-check-input" type="checkbox" id="{./enabledName}" name="{./enabledName}">
						<label class="form-check-label" for="{./enabledName}">Enabled</label>
					</div>
				</div>
				<div class="row mt-3">
					{{{ each ./fields }}}
					{{{ if ./textarea }}}
					<div class="col-12 mb-2">
						<label class="form-label" for="{./name}">{./label}</label>
						<textarea class="form-control font-monospace" rows="3" id="{./name}" name="{./name}" placeholder="{./placeholder}" spellcheck="false"></textarea>
						{{{ if ./help }}}<div class="form-text">{./help}</div>{{{ end }}}
					</div>
					{{{ else }}}
					<div class="col-sm-6 mb-2">
						<label class="form-label" for="{./name}">{./label}</label>
						<input class="form-control" type="{./type}" id="{./name}" name="{./name}" placeholder="{./placeholder}" autocomplete="off">
						{{{ if ./help }}}<div class="form-text">{./help}</div>{{{ end }}}
					</div>
					{{{ end }}}
					{{{ end }}}
					{{{ if ./lookup }}}
					<div class="col-sm-6 mb-2">
						<label class="form-label" for="{./matchName}">Match forum users by</label>
						<select class="form-select" id="{./matchName}" name="{./matchName}">
							{{{ each ./matchOptions }}}
							<option value="{./value}" {{{ if ./selected }}}selected{{{ end }}}>{./label}</option>
							{{{ end }}}
						</select>
						<div class="form-text">Display name: the forum user's full name must equal the full name or nickname of exactly one chat user. Names shared by two people match nobody.</div>
					</div>
					{{{ end }}}
				</div>
				<div class="d-flex gap-2 align-items-center mt-2">
					<button type="button" class="btn btn-outline-secondary btn-sm chatbridge-verify" data-provider="{./id}">Test connection</button>
					<button type="button" class="btn btn-outline-secondary btn-sm chatbridge-test-message" data-provider="{./id}">Send me a test message</button>
					<span class="small chatbridge-result" data-provider="{./id}"></span>
				</div>
			</div>
		</div>
		{{{ end }}}
	</form>

	<div class="card mb-3">
		<div class="card-body">
			<div class="d-flex align-items-center justify-content-between">
				<h5 class="fw-bold mb-0">Recent deliveries</h5>
				<button type="button" class="btn btn-light btn-sm" id="chatbridge-refresh-log"><i class="fa fa-rotate"></i> Refresh</button>
			</div>
			<p class="small text-muted mb-2" id="chatbridge-pending"></p>
			<div class="table-responsive">
				<table class="table table-sm align-middle mb-0">
					<thead><tr><th>When</th><th>Result</th><th>Provider</th><th>User</th><th>Event</th><th>Topic</th></tr></thead>
					<tbody id="chatbridge-log"><tr><td colspan="6" class="text-muted">Loading…</td></tr></tbody>
				</table>
			</div>
		</div>
	</div>
</div>
