import { uuid } from 'lib/uuid.js';
import { promiseChain } from 'lib/promise-utils.js';
import { time } from 'lib/time-utils.js'
import { Database } from 'lib/database.js'

const structureSql = `
CREATE TABLE folders (
	id TEXT PRIMARY KEY,
	parent_id TEXT NOT NULL DEFAULT "",
	title TEXT NOT NULL DEFAULT "",
	created_time INT NOT NULL,
	updated_time INT NOT NULL,
	sync_time INT NOT NULL DEFAULT 0
);

CREATE INDEX folders_title ON folders (title);
CREATE INDEX folders_updated_time ON folders (updated_time);
CREATE INDEX folders_sync_time ON folders (sync_time);

CREATE TABLE notes (
	id TEXT PRIMARY KEY,
	parent_id TEXT NOT NULL DEFAULT "",
	title TEXT NOT NULL DEFAULT "",
	body TEXT NOT NULL DEFAULT "",
	created_time INT NOT NULL,
	updated_time INT NOT NULL,
	sync_time INT NOT NULL DEFAULT 0,
	is_conflict INT NOT NULL DEFAULT 0,
	latitude NUMERIC NOT NULL DEFAULT 0,
	longitude NUMERIC NOT NULL DEFAULT 0,
	altitude NUMERIC NOT NULL DEFAULT 0,
	author TEXT NOT NULL DEFAULT "",
	source_url TEXT NOT NULL DEFAULT "",
	is_todo INT NOT NULL DEFAULT 0,
	todo_due INT NOT NULL DEFAULT 0,
	todo_completed INT NOT NULL DEFAULT 0,
	source TEXT NOT NULL DEFAULT "",
	source_application TEXT NOT NULL DEFAULT "",
	application_data TEXT NOT NULL DEFAULT "",
	\`order\` INT NOT NULL DEFAULT 0
);

CREATE INDEX notes_title ON notes (title);
CREATE INDEX notes_updated_time ON notes (updated_time);
CREATE INDEX notes_sync_time ON notes (sync_time);
CREATE INDEX notes_is_conflict ON notes (is_conflict);
CREATE INDEX notes_is_todo ON notes (is_todo);
CREATE INDEX notes_order ON notes (\`order\`);

CREATE TABLE deleted_items (
	id INTEGER PRIMARY KEY,
	item_type INT NOT NULL,
	item_id TEXT NOT NULL,
	deleted_time INT NOT NULL
);

CREATE TABLE tags (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL DEFAULT "",
	created_time INT NOT NULL,
	updated_time INT NOT NULL,
	sync_time INT NOT NULL DEFAULT 0
);

CREATE INDEX tags_title ON tags (title);
CREATE INDEX tags_updated_time ON tags (updated_time);
CREATE INDEX tags_sync_time ON tags (sync_time);

CREATE TABLE note_tags (
	id TEXT PRIMARY KEY,
	note_id TEXT NOT NULL,
	tag_id TEXT NOT NULL,
	created_time INT NOT NULL,
	updated_time INT NOT NULL,
	sync_time INT NOT NULL DEFAULT 0
);

CREATE INDEX note_tags_note_id ON note_tags (note_id);
CREATE INDEX note_tags_tag_id ON note_tags (tag_id);
CREATE INDEX note_tags_updated_time ON note_tags (updated_time);
CREATE INDEX note_tags_sync_time ON note_tags (sync_time);

CREATE TABLE resources (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL DEFAULT "",
	mime TEXT NOT NULL,
	filename TEXT NOT NULL DEFAULT "",
	created_time INT NOT NULL,
	updated_time INT NOT NULL,
	sync_time INT NOT NULL DEFAULT 0
);

CREATE INDEX resources_title ON resources (title);
CREATE INDEX resources_updated_time ON resources (updated_time);
CREATE INDEX resources_sync_time ON resources (sync_time);

CREATE TABLE settings (
	\`key\` TEXT PRIMARY KEY,
	\`value\` TEXT,
	\`type\` INT NOT NULL
);

CREATE TABLE table_fields (
	id INTEGER PRIMARY KEY,
	table_name TEXT NOT NULL,
	field_name TEXT NOT NULL,
	field_type INT NOT NULL,
	field_default TEXT
);

CREATE TABLE version (
	version INT NOT NULL
);

INSERT INTO version (version) VALUES (1);
`;

class JoplinDatabase extends Database {

	constructor(driver) {
		super(driver);
		this.initialized_ = false;
		this.tableFields_ = null;
	}

	initialized() {
		return this.initialized_;
	}

	async open(options) {
		await super.open(options);
		return this.initialize();
	}

	tableFieldNames(tableName) {
		let tf = this.tableFields(tableName);
		let output = [];
		for (let i = 0; i < tf.length; i++) {
			output.push(tf[i].name);
		}
		return output;
	}

	tableFields(tableName) {
		if (!this.tableFields_) throw new Error('Fields have not been loaded yet');
		if (!this.tableFields_[tableName]) throw new Error('Unknown table: ' + tableName);
		return this.tableFields_[tableName];
	}

	refreshTableFields() {
		this.logger().info('Initializing tables...');
		let queries = [];
		queries.push(this.wrapQuery('DELETE FROM table_fields'));

		return this.selectAll('SELECT name FROM sqlite_master WHERE type="table"').then((tableRows) => {
			let chain = [];
			for (let i = 0; i < tableRows.length; i++) {
				let tableName = tableRows[i].name;
				if (tableName == 'android_metadata') continue;
				if (tableName == 'table_fields') continue;
				chain.push(() => {
					return this.selectAll('PRAGMA table_info("' + tableName + '")').then((pragmas) => {
						for (let i = 0; i < pragmas.length; i++) {
							let item = pragmas[i];
							// In SQLite, if the default value is a string it has double quotes around it, so remove them here
							let defaultValue = item.dflt_value;
							if (typeof defaultValue == 'string' && defaultValue.length >= 2 && defaultValue[0] == '"' && defaultValue[defaultValue.length - 1] == '"') {
								defaultValue = defaultValue.substr(1, defaultValue.length - 2);
							}
							let q = Database.insertQuery('table_fields', {
								table_name: tableName,
								field_name: item.name,
								field_type: Database.enumId('fieldType', item.type),
								field_default: defaultValue,
							});
							queries.push(q);
						}
					});
				});
			}

			return promiseChain(chain);
		}).then(() => {
			return this.transactionExecBatch(queries);
		});
	}

	async initialize() {
		this.logger().info('Checking for database schema update...');

		for (let initLoopCount = 1; initLoopCount <= 2; initLoopCount++) {
			try {
				let row = await this.selectOne('SELECT * FROM version LIMIT 1');
				this.logger().info('Current database version', row);

				// TODO: version update logic
				// TODO: only do this if db has been updated:
				// return this.refreshTableFields();
			} catch (error) {
				if (error && error.code != 0 && error.code != 'SQLITE_ERROR') throw this.sqliteErrorToJsError(error);
		
				// Assume that error was:
				// { message: 'no such table: version (code 1): , while compiling: SELECT * FROM version', code: 0 }
				// which means the database is empty and the tables need to be created.
				// If it's any other error there's nothing we can do anyway.

				this.logger().info('Database is new - creating the schema...');

				let queries = this.wrapQueries(this.sqlStringToLines(structureSql));
				queries.push(this.wrapQuery('INSERT INTO settings (`key`, `value`, `type`) VALUES ("clientId", "' + uuid.create() + '", "' + Database.enumId('settings', 'string') + '")'));

				try {
					await this.transactionExecBatch(queries);
					this.logger().info('Database schema created successfully');
					await this.refreshTableFields();
				} catch (error) {
					throw this.sqliteErrorToJsError(error);
				}

				// Now that the database has been created, go through the normal initialisation process
				continue;
			}

			this.tableFields_ = {};

			let rows = await this.selectAll('SELECT * FROM table_fields');

			for (let i = 0; i < rows.length; i++) {
				let row = rows[i];
				if (!this.tableFields_[row.table_name]) this.tableFields_[row.table_name] = [];
				this.tableFields_[row.table_name].push({
					name: row.field_name,
					type: row.field_type,
					default: Database.formatValue(row.field_type, row.field_default),
				});
			}

			break;
		}
	}

}

Database.TYPE_INT = 1;
Database.TYPE_TEXT = 2;
Database.TYPE_NUMERIC = 3;

export { JoplinDatabase };