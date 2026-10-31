-- BEL-150: the contract for 093. A secret holds only its store reference and version, a non-secret only its
-- value. It refuses while a plaintext secret remains rather than converting one, and deletes nothing: the
-- refusal names the conversion command of the previous release, and an oversized value (over the store's
-- 32768-byte limit, MAX_SECRET_BYTES) is re-entered by a member.

do $$
declare
    plaintext bigint;
    oversized bigint;
begin
    select count(*), count(*) filter (where octet_length(value) > 32768)
      into plaintext, oversized
      from env_var
     where is_secret and secret_ref is null and value is not null;
    if plaintext > 0 then
        raise exception 'env_var holds % plaintext secret row(s) (% over 32768 bytes): run npm run secrets:convert-env on v0.0.13 until it exits 0, have a member re-enter each oversized one, then upgrade',
            plaintext, oversized
            using errcode = '55000';
    end if;
end $$;

alter table env_var add constraint env_var_secret_form_ck check (
    (is_secret and value is null and secret_ref is not null and secret_version is not null)
    or (not is_secret and value is not null and secret_ref is null)
);
