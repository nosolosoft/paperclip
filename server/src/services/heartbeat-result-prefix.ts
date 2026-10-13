import { sql, type SQL } from "drizzle-orm";

// Legacy embedded SQL_ASCII clusters count bytes in left(), even when the
// client and stored JSON are UTF-8. Keep a bounded prefix on a code-point
// boundary before PostgreSQL converts it for the client or builds JSON.
// Native encodings retain their character-count semantics. SQL_ASCII retains
// its byte budget, dropping only an incomplete trailing UTF-8 code point.
export function boundedRunResultText(value: SQL, maxChars: number) {
  return sql<string | null>`case when current_setting('server_encoding') <> 'SQL_ASCII'
    then left(${value}, ${maxChars})
    else (
      select convert_from(substring(prefix from 1 for
        case when prefix is null or ${maxChars} <= 0 or octet_length(prefix) <= ${maxChars} then ${maxChars}
          when get_byte(prefix, ${maxChars}) not between 128 and 191 then ${maxChars}
          when get_byte(prefix, ${Math.max(0, maxChars - 1)}) >= 192 then ${Math.max(0, maxChars - 1)}
          when ${maxChars} >= 2 and get_byte(prefix, ${Math.max(0, maxChars - 2)}) >= 192 then ${maxChars - 2}
          else ${Math.max(0, maxChars - 3)} end::integer), 'SQL_ASCII')
      from (select substring(convert_to(${value}, 'SQL_ASCII') from 1 for ${maxChars + 1}) as prefix) bounded
    ) end`;
}
